function createUnsupportedStreamRequestError(message) {
    const error = new Error(message);
    error.code = 'STREMIO_UNSUPPORTED_STREAM_REQUEST';
    error.statusCode = 200;
    return error;
}

function isUnsupportedStreamRequestError(error) {
    return error?.code === 'STREMIO_UNSUPPORTED_STREAM_REQUEST';
}

function validateStreamRequest(type, id) {
    const validTypes = ['movie', 'series', 'anime'];
    if (!validTypes.includes(type)) throw createUnsupportedStreamRequestError(`Tipo non valido: ${type}`);
    const cleanIdToCheck = id.replace('ai-recs:', '');
    const idPattern = /^(tt\d+|\d+|tmdb:\d+|kitsu:\d+)(:\d+)?(:\d+)?$/;
    if (!idPattern.test(cleanIdToCheck) && !idPattern.test(id)) throw createUnsupportedStreamRequestError(`Formato ID non valido: ${id}`);
    return true;
}

async function withTimeout(promise, ms, operation = 'Operation') {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error(`TIMEOUT: ${operation} exceeded ${ms}ms`));
        }, ms);
    });
    try {
        const result = await Promise.race([promise, timeoutPromise]);
        clearTimeout(timer);
        return result;
    } catch (error) {
        clearTimeout(timer);
        throw error;
    }
}

module.exports = {
    createUnsupportedStreamRequestError,
    isUnsupportedStreamRequestError,
    validateStreamRequest,
    withTimeout
};
