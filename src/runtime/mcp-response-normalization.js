function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    if (value.length === 0) continue;
    return value;
  }
  return null;
}

function normalizeContentBlock(block) {
  if (typeof block === 'string') {
    return { type: 'text', text: block };
  }
  if (!isObject(block)) return null;

  const text = firstNonEmptyString(block.text, block.value);
  if (typeof text !== 'string') {
    return block;
  }

  const type = typeof block.type === 'string' ? block.type : '';
  if (!type || type === 'text' || type === 'output_text') {
    if (type === 'text' && block.text === text) {
      return block;
    }
    return {
      ...block,
      type: 'text',
      text,
    };
  }

  return block;
}

function normalizeContent(content) {
  if (content === undefined || content === null) return null;

  const items = Array.isArray(content) ? content : [content];
  const normalized = items
    .map(normalizeContentBlock)
    .filter(item => item !== null);

  return normalized;
}

function looksLikeToolResult(result) {
  if (!isObject(result)) return false;
  return hasOwn(result, 'content')
    || hasOwn(result, 'structuredContent')
    || hasOwn(result, 'structured_content')
    || hasOwn(result, 'isError')
    || hasOwn(result, 'is_error');
}

export function normalizeToolResult(result) {
  if (!looksLikeToolResult(result)) return result;

  let changed = false;
  const normalized = { ...result };

  if (!hasOwn(normalized, 'structured_content') && hasOwn(result, 'structuredContent')) {
    normalized.structured_content = result.structuredContent;
    changed = true;
  }
  if (!hasOwn(normalized, 'structuredContent') && hasOwn(result, 'structured_content')) {
    normalized.structuredContent = result.structured_content;
    changed = true;
  }

  if (!hasOwn(normalized, 'is_error') && hasOwn(result, 'isError')) {
    normalized.is_error = result.isError;
    changed = true;
  }
  if (!hasOwn(normalized, 'isError') && hasOwn(result, 'is_error')) {
    normalized.isError = result.is_error;
    changed = true;
  }

  const normalizedContent = normalizeContent(result.content);
  if (normalizedContent !== null) {
    if (!Array.isArray(result.content) || normalizedContent.length !== result.content.length) {
      normalized.content = normalizedContent;
      changed = true;
    } else {
      for (let index = 0; index < normalizedContent.length; index += 1) {
        if (normalizedContent[index] !== result.content[index]) {
          normalized.content = normalizedContent;
          changed = true;
          break;
        }
      }
    }
  }

  if (!Array.isArray(normalized.content) || normalized.content.length === 0) {
    const fallbackText = firstNonEmptyString(
      result.text,
      result.message,
      result.output_text,
      result.outputText,
      normalized.structured_content?.text,
      result.structuredContent?.text,
    );
    if (fallbackText !== null) {
      normalized.content = [{ type: 'text', text: fallbackText }];
      changed = true;
    }
  }

  return changed ? normalized : result;
}

export function normalizeToolResultResponseMessage(message) {
  if (!isObject(message) || !hasOwn(message, 'result')) return message;
  const normalizedResult = normalizeToolResult(message.result);
  if (normalizedResult === message.result) return message;
  return {
    ...message,
    result: normalizedResult,
  };
}
