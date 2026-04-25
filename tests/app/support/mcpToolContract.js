import assert from 'node:assert/strict';

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertToolCallResultContract(
  result,
  {
    requireStructuredContent = false,
    requireIsError = undefined,
    minContentBlocks = 1,
  } = {},
) {
  assert.ok(isObject(result), 'tools/call should return an object result payload');
  assert.ok(Array.isArray(result.content), 'tools/call result should include content[]');
  assert.ok(
    result.content.length >= minContentBlocks,
    `tools/call result should include at least ${minContentBlocks} content block(s)`,
  );

  if (requireStructuredContent) {
    assert.ok(
      Object.hasOwn(result, 'structuredContent'),
      'tools/call result should expose structuredContent in camelCase',
    );
    assert.ok(
      isObject(result.structuredContent) || result.structuredContent === null,
      'structuredContent should be an object or null when present',
    );
  }

  if (requireIsError !== undefined) {
    assert.ok(
      Object.hasOwn(result, 'isError'),
      'tools/call error results should expose isError in camelCase',
    );
    assert.equal(result.isError, requireIsError);
  }

  return result;
}

export function getToolCallStructuredContent(result) {
  if (!isObject(result)) return null;
  if (Object.hasOwn(result, 'structuredContent')) return result.structuredContent;
  if (Object.hasOwn(result, 'structured_content')) return result.structured_content;
  return null;
}

export function readToolCallText(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  return blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n');
}

export function assertJsonRpcErrorEnvelope(
  response,
  { code = undefined, message = undefined } = {},
) {
  assert.ok(isObject(response), 'response should be an object');
  assert.ok(Object.hasOwn(response, 'error'), 'response should use the JSON-RPC error envelope');
  assert.ok(
    !Object.hasOwn(response, 'result'),
    'JSON-RPC error responses should not also include result',
  );

  if (code !== undefined) {
    assert.equal(response.error?.code, code);
  }
  if (message !== undefined) {
    const text = String(response.error?.message ?? '');
    if (message instanceof RegExp) {
      assert.match(text, message);
    } else {
      assert.ok(
        text.includes(String(message)),
        `Expected error message to include ${JSON.stringify(message)}, got ${JSON.stringify(text)}`,
      );
    }
  }

  return response.error;
}
