/**
 * Lightweight Test Runner for Sandbox Apps
 * Zero dependencies, ES Modules native, browser-based
 */

export class TestRunner {
  constructor() {
    this.suites = [];
    this.currentSuite = null;
  }

  describe(name, fn) {
    const suite = {
      name,
      tests: [],
      beforeEach: null,
      afterEach: null,
    };
    this.suites.push(suite);
    const prevSuite = this.currentSuite;
    this.currentSuite = suite;
    fn();
    this.currentSuite = prevSuite;
  }

  it(name, fn) {
    if (!this.currentSuite) {
      throw new Error('it() must be called inside describe()');
    }
    this.currentSuite.tests.push({ name, fn });
  }

  beforeEach(fn) {
    if (this.currentSuite) {
      this.currentSuite.beforeEach = fn;
    }
  }

  afterEach(fn) {
    if (this.currentSuite) {
      this.currentSuite.afterEach = fn;
    }
  }

  async run() {
    const results = {
      passed: 0,
      failed: 0,
      errors: [],
      suites: [],
    };

    for (const suite of this.suites) {
      const suiteResult = {
        name: suite.name,
        tests: [],
      };

      console.group(`Suite: ${suite.name}`);

      for (const test of suite.tests) {
        const testResult = { name: test.name, passed: false, error: null };

        try {
          if (suite.beforeEach) {
            await suite.beforeEach();
          }

          await test.fn();

          if (suite.afterEach) {
            await suite.afterEach();
          }

          console.log(`  %c\u2713 ${test.name}`, 'color: #4caf50');
          testResult.passed = true;
          results.passed++;
        } catch (error) {
          console.error(`  %c\u2717 ${test.name}`, 'color: #f44336');
          console.error(`    ${error.message}`);
          testResult.error = error;
          results.failed++;
          results.errors.push({
            suite: suite.name,
            test: test.name,
            error,
          });
        }

        suiteResult.tests.push(testResult);
      }

      console.groupEnd();
      results.suites.push(suiteResult);
    }

    return results;
  }
}

export const assert = {
  equal(actual, expected, msg = '') {
    if (actual !== expected) {
      throw new Error(
        `${msg ? msg + ': ' : ''}Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
      );
    }
  },

  notEqual(actual, expected, msg = '') {
    if (actual === expected) {
      throw new Error(
        `${msg ? msg + ': ' : ''}Expected value to not equal ${JSON.stringify(expected)}`
      );
    }
  },

  deepEqual(actual, expected, msg = '') {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `${msg ? msg + ': ' : ''}Objects are not deeply equal\n` +
          `Expected: ${JSON.stringify(expected)}\n` +
          `Actual: ${JSON.stringify(actual)}`
      );
    }
  },

  true(value, msg = '') {
    if (value !== true) {
      throw new Error(`${msg ? msg + ': ' : ''}Expected true, got ${value}`);
    }
  },

  false(value, msg = '') {
    if (value !== false) {
      throw new Error(`${msg ? msg + ': ' : ''}Expected false, got ${value}`);
    }
  },

  truthy(value, msg = '') {
    if (!value) {
      throw new Error(`${msg ? msg + ': ' : ''}Expected truthy value, got ${value}`);
    }
  },

  falsy(value, msg = '') {
    if (value) {
      throw new Error(`${msg ? msg + ': ' : ''}Expected falsy value, got ${value}`);
    }
  },

  throws(fn, msg = '') {
    let threw = false;
    try {
      fn();
    } catch {
      threw = true;
    }
    if (!threw) {
      throw new Error(`${msg ? msg + ': ' : ''}Expected function to throw`);
    }
  },

  async throwsAsync(fn, msg = '') {
    let threw = false;
    try {
      await fn();
    } catch {
      threw = true;
    }
    if (!threw) {
      throw new Error(`${msg ? msg + ': ' : ''}Expected async function to throw`);
    }
  },

  approximately(actual, expected, tolerance, msg = '') {
    const diff = Math.abs(actual - expected);
    if (diff > tolerance) {
      throw new Error(
        `${msg ? msg + ': ' : ''}Expected ${actual} to be within ${tolerance} of ${expected} (diff: ${diff})`
      );
    }
  },

  arrayApproximatelyEqual(actual, expected, tolerance, msg = '') {
    if (actual.length !== expected.length) {
      throw new Error(
        `${msg ? msg + ': ' : ''}Array lengths differ: ${actual.length} vs ${expected.length}`
      );
    }
    for (let i = 0; i < actual.length; i++) {
      const diff = Math.abs(actual[i] - expected[i]);
      if (diff > tolerance) {
        throw new Error(
          `${msg ? msg + ': ' : ''}Array element [${i}]: Expected ${actual[i]} to be within ${tolerance} of ${expected[i]}`
        );
      }
    }
  },

  instanceof(value, constructor, msg = '') {
    if (!(value instanceof constructor)) {
      throw new Error(
        `${msg ? msg + ': ' : ''}Expected instance of ${constructor.name}`
      );
    }
  },
};

/**
 * Create a test runner with bound methods for convenient destructuring
 */
export function createTestRunner() {
  const runner = new TestRunner();
  return {
    runner,
    describe: runner.describe.bind(runner),
    it: runner.it.bind(runner),
    beforeEach: runner.beforeEach.bind(runner),
    afterEach: runner.afterEach.bind(runner),
  };
}

/**
 * Render test results to a DOM element
 */
export function renderResults(results, container) {
  container.innerHTML = '';

  const summary = document.createElement('div');
  summary.className = 'test-summary';
  summary.innerHTML = `
    <h2>Test Results</h2>
    <p class="passed">Passed: ${results.passed}</p>
    <p class="failed">Failed: ${results.failed}</p>
  `;
  container.appendChild(summary);

  for (const suite of results.suites) {
    const suiteEl = document.createElement('div');
    suiteEl.className = 'test-suite';

    const suiteHeader = document.createElement('h3');
    suiteHeader.textContent = suite.name;
    suiteEl.appendChild(suiteHeader);

    const testList = document.createElement('ul');
    for (const test of suite.tests) {
      const testEl = document.createElement('li');
      testEl.className = test.passed ? 'test-passed' : 'test-failed';
      testEl.innerHTML = `
        <span class="test-icon">${test.passed ? '\u2713' : '\u2717'}</span>
        <span class="test-name">${test.name}</span>
        ${test.error ? `<pre class="test-error">${test.error.message}</pre>` : ''}
      `;
      testList.appendChild(testEl);
    }
    suiteEl.appendChild(testList);
    container.appendChild(suiteEl);
  }
}
