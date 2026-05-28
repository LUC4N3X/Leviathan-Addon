function isTruthyConfigValue(value) {
    return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

module.exports = {
    isTruthyConfigValue
};
