const ULTRA_JUNK_TOKENS = new Set([
    "ita", "eng", "sub", "subita", "dub", "multi", "dual", "audio",
    "x264", "x265", "h264", "hevc", "divx", "xvid", "av1", "vp9",
    "webrip", "bdrip", "dvdrip", "hdrip", "brrip", "web-dl", "bluray", "remux",
    "1080p", "720p", "4k", "2160p", "sd", "hd", "fhd", "uhd",
    "extended", "director", "unrated", "uncut", "repack"
]);

const ULTRA_SEMANTIC_ALIASES = {
    "harry potter": ["hp", "pietra filosofale", "camera segreti", "prigioniero azkaban", "calice fuoco", "ordine fenice", "principe mezzosangue", "doni morte"],
    "il signore degli anelli": ["lord of the rings", "lotr", "compagnia anello", "due torri", "ritorno re"],
    "fast and furious": ["fast & furious", "fast x", "f10"],
    "la casa di carta": ["money heist", "la casa de papel"],
    "il trono di spade": ["game of thrones", "got"],
    "l'attacco dei giganti": ["attack on titan", "aot", "shingeki no kyojin"],
    "one piece": ["one piece", "op"],
    "demon slayer": ["kimetsu no yaiba"],
    "jujutsu kaisen": ["sorcery fight"],
    "my hero academia": ["boku no hero academia"],
    "star wars": ["guerre stellari"],
    "the avengers": ["avengers"]
};

function ultraNormalizeTitle(t) {
    if (!t) return "";
    return t.toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "") 
        .replace(/&/g, " and ") 
        .replace(/[':;,-.?!]/g, " ") 
        .replace(/[^a-z0-9\s]/g, "") 
        .replace(/\s+/g, " ").trim(); 
}

function getNumericVariants(title) {
    const romanMap = { " 1 ": " i ", " 2 ": " ii ", " 3 ": " iii ", " 4 ": " iv ", " 5 ": " v ", " 6 ": " vi ", " 7 ": " vii " };
    const arabicMap = { " i ": " 1 ", " ii ": " 2 ", " iii ": " 3 ", " iv ": " 4 ", " v ": " 5 ", " vi ": " 6 ", " vii ": " 7 " };
    
    let variants = [];
    let padded = " " + title + " "; 

    for (let [num, rom] of Object.entries(romanMap)) {
        if (padded.includes(num)) variants.push(padded.replace(num, rom).trim());
    }
    for (let [rom, num] of Object.entries(arabicMap)) {
        if (padded.includes(rom)) variants.push(padded.replace(rom, num).trim());
    }
    return variants;
}

function stripArticles(title) {
    const regex = /^(the|il|lo|la|i|gli|le|un|uno|una|a|an)\s+/i;
    if (regex.test(title)) {
        return title.replace(regex, "").trim();
    }
    return null;
}

function autoExpandAliases(cleanTitle) {
    let aliases = new Set();
    for (const [key, variants] of Object.entries(ULTRA_SEMANTIC_ALIASES)) {
        if (cleanTitle.includes(key) || key.includes(cleanTitle)) {
             variants.forEach(a => aliases.add(a));
        }
    }
    return Array.from(aliases);
}

function commonWordsOnly(text) {
    const commons = ["the", "and", "for", "with", "movie", "film", "la", "il", "di", "dei", "le", "un", "in", "on", "at", "to"];
    return text.split(" ").every(w => commons.includes(w.toLowerCase()));
}

function generateSmartQueries(meta, dynamicAliases = [], allowEng = false) {
    const { title, originalTitle, year, season, episode, isSeries } = meta;
    
    const cleanTitle = ultraNormalizeTitle(title);
    const cleanOriginal = originalTitle ? ultraNormalizeTitle(originalTitle) : "";
    
    let itaTitles = new Set();
    let engTitles = new Set();
    
    const addVariants = (t) => {
        if (!t || t.length < 2) return;
        
        itaTitles.add(t);
        if (allowEng) engTitles.add(t);

        const stripped = stripArticles(t);
        if (stripped && stripped.length > 2) {
            itaTitles.add(stripped);
            if (allowEng) engTitles.add(stripped);
        }

        getNumericVariants(t).forEach(v => {
            itaTitles.add(v);
            if (allowEng) engTitles.add(v);
        });

        if (title && (title.includes(":") || title.includes("-"))) {
            const parts = title.split(/[:\-]/);
            const firstPart = ultraNormalizeTitle(parts[0]);
            if (firstPart.length > 3 && !commonWordsOnly(firstPart)) {
                itaTitles.add(firstPart);
                if (allowEng) engTitles.add(firstPart);
            }
        }
    };

    addVariants(cleanTitle);
    addVariants(cleanOriginal);

    if (dynamicAliases && dynamicAliases.length > 0) {
        dynamicAliases.forEach(alias => {
            const ca = ultraNormalizeTitle(alias);
            if (ca && ca.length > 2) addVariants(ca);
        });
    }

    [...itaTitles].forEach(t => {
        autoExpandAliases(t).forEach(a => addVariants(a));
    });

    let finalQueries = [];
    const sStr = season ? String(season).padStart(2, "0") : "";
    const eStr = episode ? String(episode).padStart(2, "0") : "";
    const langSuffix = "ITA"; 

    let itaQueries = new Set();
    itaTitles.forEach(t => {
        if (isSeries) {
            if (episode) {
                itaQueries.add(`${t} S${sStr}E${eStr} ${langSuffix}`); 
                itaQueries.add(`${t} S${sStr}E${eStr}`); 
                itaQueries.add(`${t} ${season}x${eStr}`); 
                itaQueries.add(`${t} ${episode}`); 
            }
            itaQueries.add(`${t} Stagione ${season} ${langSuffix}`);
            itaQueries.add(`${t} S${sStr} ${langSuffix}`);
        } else {
            itaQueries.add(`${t} ${year} ${langSuffix}`);
            itaQueries.add(`${t} ${langSuffix}`); 
            if (year) {
                const yNum = parseInt(year);
                itaQueries.add(`${t} ${yNum - 1} ${langSuffix}`);
                itaQueries.add(`${t} ${yNum + 1} ${langSuffix}`);
            }
        }
    });
    finalQueries.push(...Array.from(itaQueries).sort((a, b) => b.length - a.length));

    if (allowEng) {
        let engQueries = new Set();
        engTitles.forEach(t => {
            if (isSeries) {
                if (episode) {
                    engQueries.add(`${t} S${sStr}E${eStr}`);
                    engQueries.add(`${t} ${season}x${eStr}`);
                }
                engQueries.add(`${t} Season ${season}`);
                engQueries.add(`${t} S${sStr}`);
            } else {
                engQueries.add(`${t} ${year}`);
                if (t.length >= 3 && !commonWordsOnly(t)) engQueries.add(t);
            }
        });

        finalQueries.push(...Array.from(engQueries).sort((a, b) => b.length - a.length));
    }

    return finalQueries;
}

module.exports = { generateSmartQueries, ultraNormalizeTitle, ULTRA_SEMANTIC_ALIASES, ULTRA_JUNK_TOKENS };
