import asyncio
import functools
import importlib
import logging
import os

logger = logging.getLogger("leviathan_cf_patch")

CHECKBOX_SELECTORS = (
    'input[type="checkbox"]',
    'input[type="Checkbox"]',
    '#challenge-stage input',
    'label.cb-lb input',
)

COOKIE_TTL_MINUTES = max(1, int(os.environ.get("CF_COOKIE_TTL_MINUTES", "15") or "15"))
FORCE_HEADLESS = str(os.environ.get("CLOUDFLARE_BYPASS_HEADLESS", os.environ.get("PLAYWRIGHT_HEADLESS", "true"))).strip().lower() not in {"0", "false", "no", "off", "headed"}
FORCE_BROWSER_ARGS = (
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-software-rasterizer",
)


def _merge_browser_args(value):
    if value is None:
        merged = []
    elif isinstance(value, (list, tuple)):
        merged = [str(item) for item in value if str(item).strip()]
    else:
        merged = [str(value)]

    present = set(merged)
    for item in FORCE_BROWSER_ARGS:
        if item not in present:
            merged.append(item)
            present.add(item)
    return merged


def _force_headless_kwargs(kwargs):
    normalized = dict(kwargs or {})
    if FORCE_HEADLESS:
        normalized["headless"] = True
    normalized["args"] = _merge_browser_args(normalized.get("args"))
    return normalized


def _wrap_async_method(original):
    if getattr(original, "_leviathan_headless_patch", False):
        return original

    @functools.wraps(original)
    async def wrapped(self, *args, **kwargs):
        return await original(self, *args, **_force_headless_kwargs(kwargs))

    wrapped._leviathan_headless_patch = True
    return wrapped


def _wrap_sync_method(original):
    if getattr(original, "_leviathan_headless_patch", False):
        return original

    @functools.wraps(original)
    def wrapped(self, *args, **kwargs):
        return original(self, *args, **_force_headless_kwargs(kwargs))

    wrapped._leviathan_headless_patch = True
    return wrapped


def _install_playwright_headless_patch():
    patched = 0
    targets = (
        ("playwright.async_api._generated", "BrowserType", ("launch", "launch_persistent_context"), _wrap_async_method),
        ("playwright.sync_api._generated", "BrowserType", ("launch", "launch_persistent_context"), _wrap_sync_method),
        ("playwright._impl._browser_type", "BrowserType", ("launch", "launch_persistent_context"), _wrap_async_method),
    )

    for module_name, class_name, method_names, wrapper in targets:
        try:
            module = importlib.import_module(module_name)
            cls = getattr(module, class_name)
            for method_name in method_names:
                original = getattr(cls, method_name, None)
                if original is None:
                    continue
                setattr(cls, method_name, wrapper(original))
                patched += 1
        except Exception as exc:
            logger.debug("playwright headless patch skipped for %s.%s: %s", module_name, class_name, exc)

    if patched:
        logger.info("Playwright Docker headless patch installed on %d launch methods", patched)
    else:
        logger.warning("Playwright Docker headless patch was not installed because no launch method was found")


def _install_checkbox_patch():
    from playwright_captcha.solvers.click.cloudflare.utils import dom_helpers
    from playwright_captcha.solvers.click.common.shadow_root import search_shadow_root_elements

    async def collect_frames(root):
        frames = []
        seen = set()
        stack = [root]
        while stack:
            current = stack.pop()
            if current is None:
                continue
            try:
                if current.is_detached():
                    continue
            except Exception:
                continue
            marker = id(current)
            if marker in seen:
                continue
            seen.add(marker)
            frames.append(current)
            try:
                for child in current.child_frames:
                    stack.append(child)
            except Exception:
                pass
        return frames

    async def find_checkboxes(framework, frame):
        found = []
        for selector in CHECKBOX_SELECTORS:
            try:
                found += await search_shadow_root_elements(framework, frame, selector)
            except Exception as exc:
                logger.debug("shadow search failed (%s): %s", selector, exc)
            if not found:
                try:
                    direct = await frame.query_selector_all(selector)
                    if direct:
                        found += direct
                except Exception as exc:
                    logger.debug("direct search failed (%s): %s", selector, exc)
            if found:
                break
        return found

    async def get_ready_checkbox(framework, iframes, delay, attempts):
        if attempts <= 0:
            attempts = 1

        for _ in range(attempts):
            try:
                checkboxes = []
                for iframe in iframes:
                    try:
                        if iframe.is_detached():
                            continue
                    except Exception:
                        continue
                    for frame in await collect_frames(iframe):
                        for checkbox in await find_checkboxes(framework, frame):
                            checkboxes.append((frame, checkbox))

                logger.info("Found %d checkboxes in %d Cloudflare iframes", len(checkboxes), len(iframes))

                visible = []
                for frame, checkbox in checkboxes:
                    try:
                        if await checkbox.is_visible():
                            visible.append((frame, checkbox))
                    except Exception:
                        continue

                if visible:
                    logger.info("Checkbox input is ready to be clicked")
                    return visible[0]

                if checkboxes:
                    logger.info("Checkbox present but not visible yet, retrying")

                logger.info("Waiting for Cloudflare checkbox input...")
                await asyncio.sleep(delay)
            except Exception as exc:
                logger.error("Error while waiting for checkbox: %s", exc)

        logger.error("Max attempts reached while waiting for Cloudflare checkbox input")
        return None

    dom_helpers.get_ready_checkbox = get_ready_checkbox

    try:
        from playwright_captcha.solvers.click.cloudflare import solve_by_click
        solve_by_click.get_ready_checkbox = get_ready_checkbox
    except Exception as exc:
        logger.debug("solve_by_click rebind skipped: %s", exc)

    logger.info("Cloudflare checkbox detection patch installed")


def _install_cookie_ttl_patch():
    from datetime import datetime, timedelta
    from cf_bypasser.cache.cookie_cache import CookieCache, CachedCookies

    original_set = CookieCache.set

    def capped_set(self, *args, **kwargs):
        if kwargs.get("ttl_minutes") is not None:
            kwargs["ttl_minutes"] = min(int(kwargs["ttl_minutes"]), COOKIE_TTL_MINUTES)
        elif len(args) >= 4 and args[3] is not None:
            args = list(args)
            args[3] = min(int(args[3]), COOKIE_TTL_MINUTES)
            args = tuple(args)
        else:
            kwargs.setdefault("ttl_minutes", COOKIE_TTL_MINUTES)
        return original_set(self, *args, **kwargs)

    def capped_is_expired(self):
        hard_expiry = self.expires_at
        try:
            capped = self.timestamp + timedelta(minutes=COOKIE_TTL_MINUTES)
            if capped < hard_expiry:
                hard_expiry = capped
        except Exception:
            pass
        return datetime.now() >= hard_expiry

    CookieCache.set = capped_set
    CachedCookies.is_expired = capped_is_expired
    logger.info("Cloudflare cookie cache TTL capped at %d minutes", COOKIE_TTL_MINUTES)


for installer in (_install_playwright_headless_patch, _install_checkbox_patch, _install_cookie_ttl_patch):
    try:
        installer()
    except Exception as exc:
        logger.warning("patch skipped (%s): %s", installer.__name__, exc)
