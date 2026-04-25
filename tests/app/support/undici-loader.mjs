const UNDICI_SHIM_URL = new URL('./undici-shim.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'undici') {
    return {
      shortCircuit: true,
      url: UNDICI_SHIM_URL,
    };
  }

  return nextResolve(specifier, context);
}
