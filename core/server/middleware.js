'use strict';

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

function applyCommonMiddleware(app, { staticDir }) {
    app.set('trust proxy', 1);

    const RATE_LIMIT_WINDOW_MS = Math.max(60 * 1000, parseInt(process.env.RATE_LIMIT_WINDOW_MS || String(15 * 60 * 1000), 10) || (15 * 60 * 1000));
    const RATE_LIMIT_MAX = Math.max(50, parseInt(process.env.RATE_LIMIT_MAX || '350', 10) || 350);

    app.use(compression({
        filter: (req, res) => {
            if (req.headers['x-no-compression']) return false;
            return compression.filter(req, res);
        },
        level: 6
    }));

    const limiter = rateLimit({
        windowMs: RATE_LIMIT_WINDOW_MS,
        max: RATE_LIMIT_MAX,
        standardHeaders: true,
        legacyHeaders: false,
        message: 'Troppe richieste da questo IP, riprova più tardi.'
    });

    app.use(limiter);
    app.use(cors());
    app.use(helmet({
        contentSecurityPolicy: false,
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: false,
        hsts: process.env.NODE_ENV === 'production'
    }));
    app.use((req, res, next) => {
        res.setHeader('Referrer-Policy', 'no-referrer');
        next();
    });
    app.use(express.json({ limit: process.env.JSON_LIMIT || '64kb' }));
    app.use(express.urlencoded({ extended: false, limit: process.env.URLENCODED_LIMIT || '32kb' }));
    app.use(express.static(staticDir));
}

module.exports = { applyCommonMiddleware };
