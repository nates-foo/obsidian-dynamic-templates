function assert(value, message) {
    let color;
    let status;
    if (value) {
        color = '#8AC926';
        status = 'SUCCESS';
    }  else {
        color = '#FF595E';
        status = 'FAIL';
    }
    return `<div style="width: 100%; background-color: ${color}; padding: 1em">
        <span style="font-weight: bold">${status}:</span>
        ${message}
    </div>\n`;
}

module.exports = assert;