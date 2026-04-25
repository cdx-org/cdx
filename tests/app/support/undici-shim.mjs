export class Agent {
  constructor(options = {}) {
    this.options = options;
  }

  async close() {}

  destroy() {}
}

export const fetch = (...args) => {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('global fetch is unavailable');
  }
  return globalThis.fetch(...args);
};
