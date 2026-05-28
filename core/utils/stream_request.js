function validateStreamRequest(type, id) {
    const validTypes = ['movie', 'series', 'anime'];
    if (!validTypes.includes(type)) throw new Error(`Tipo non valido: ${type}`);
    const cleanIdToCheck = id.replace('ai-recs:', '');
    const idPattern = /^(tt\d+|\d+|tmdb:\d+|kitsu:\d+)(:\d+)?(:\d+)?$/;
    if (!idPattern.test(cleanIdToCheck) && !idPattern.test(id)) throw new Error(`Formato ID non valido: ${id}`);
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
    validateStreamRequest,
    withTimeout
};
