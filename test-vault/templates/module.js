const test = require('test.js');

return test({
    name: 'module',
    assert: [
        [module.bar(2) === 'barbar', 'Module is correctly imported']
    ]
});

const assert = require('assert.js');

const module = require('foobar.js');

return assert(module.bar(2) === 'barbar', 'Module is correctly imported');
