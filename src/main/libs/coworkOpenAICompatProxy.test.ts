import { expect, test, vi } from 'vitest';

import { __openAICompatProxyTestUtils } from './coworkOpenAICompatProxy';

const parseSSEWrites = (writes: string[]) => writes.flatMap((write) => (
  write
    .trim()
    .split(/\n\n/)
    .filter(Boolean)
    .map((packet) => {
      const event = packet.match(/^event:\s*(.+)$/m)?.[1] ?? '';
      const data = packet.match(/^data:\s*(.+)$/m)?.[1] ?? '{}';
      return {
        event,
        data: JSON.parse(data) as Record<string, unknown>,
      };
    })
));

test('convertResponsesRequestToChatCompletionsRequest maps developer role to system', () => {
  const converted = __openAICompatProxyTestUtils.convertResponsesRequestToChatCompletionsRequest({
    model: 'deepseek-v4-flash',
    input: [
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'Follow the workspace policy.' }],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      },
    ],
  });

  expect(converted.messages).toEqual([
    { role: 'system', content: 'Follow the workspace policy.' },
    { role: 'user', content: 'hello' },
  ]);
});

test('processResponsesStreamEvent emits streamed function call metadata and arguments', () => {
  const writes: string[] = [];
  const res = {
    write: vi.fn((chunk: string) => {
      writes.push(chunk);
      return true;
    }),
  };
  const state = __openAICompatProxyTestUtils.createStreamState();
  const context = __openAICompatProxyTestUtils.createResponsesStreamContext();

  __openAICompatProxyTestUtils.processResponsesStreamEvent(
    res as never,
    state,
    context,
    'response.output_item.added',
    {
      response_id: 'resp_1',
      model: 'gpt-test',
      output_index: 0,
      item: {
        id: 'item_1',
        type: 'function_call',
        call_id: 'call_1',
        name: 'lookup',
      },
    },
  );
  __openAICompatProxyTestUtils.processResponsesStreamEvent(
    res as never,
    state,
    context,
    'response.function_call_arguments.done',
    {
      response_id: 'resp_1',
      model: 'gpt-test',
      output_index: 0,
      call_id: 'call_1',
      arguments: '{"query":"weather"}',
    },
  );

  const events = parseSSEWrites(writes);
  const toolStart = events.find((item) => item.event === 'content_block_start');
  const argumentDelta = events.find((item) => item.event === 'content_block_delta');

  expect(toolStart?.data.content_block).toMatchObject({
    type: 'tool_use',
    id: 'call_1',
    name: 'lookup',
  });
  expect(argumentDelta?.data.delta).toEqual({
    type: 'input_json_delta',
    partial_json: '{"query":"weather"}',
  });
});

test('convertChatCompletionsRequestToResponsesRequest auto-closes missing tool outputs', () => {
  const converted = __openAICompatProxyTestUtils.convertChatCompletionsRequestToResponsesRequest({
    model: 'gpt-test',
    messages: [
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_missing',
            type: 'function',
            function: {
              name: 'lookup',
              arguments: '{"query":"weather"}',
            },
          },
        ],
      },
    ],
  });

  expect(converted.input).toEqual([
    {
      type: 'function_call',
      call_id: 'call_missing',
      name: 'lookup',
      arguments: '{"query":"weather"}',
    },
    {
      type: 'function_call_output',
      call_id: 'call_missing',
      output: expect.stringContaining('Missing tool output'),
    },
  ]);
});

test('filterOpenAIToolsForProvider removes Skill tools and resets forced choices', () => {
  const request = {
    tools: [
      { type: 'function', function: { name: 'Skill' } },
      { type: 'function', function: { name: 'Read' } },
    ],
    tool_choice: {
      type: 'function',
      function: { name: 'skill' },
    },
  };

  __openAICompatProxyTestUtils.filterOpenAIToolsForProvider(request, 'openai');

  expect(request.tools).toEqual([
    { type: 'function', function: { name: 'Read' } },
  ]);
  expect(request.tool_choice).toBe('auto');
});

test('isGeminiProvider detects explicit provider and Google base URL', () => {
  expect(__openAICompatProxyTestUtils.isGeminiProvider('gemini')).toBe(true);
  expect(__openAICompatProxyTestUtils.isGeminiProvider(
    'custom',
    'https://generativelanguage.googleapis.com/v1beta/openai/',
  )).toBe(true);
  expect(__openAICompatProxyTestUtils.isGeminiProvider('openai', 'https://api.openai.com/v1')).toBe(false);
});

test('normalizeProviderModelId maps legacy MiniMax M3 alias to official model id', () => {
  expect(__openAICompatProxyTestUtils.normalizeProviderModelId('MiniMax-M3.0', 'minimax')).toBe('MiniMax-M3');
  expect(__openAICompatProxyTestUtils.normalizeProviderModelId('minimax-m3.0', 'minimax')).toBe('MiniMax-M3');
  expect(__openAICompatProxyTestUtils.normalizeProviderModelId('MiniMax-M2.7', 'minimax')).toBe('MiniMax-M2.7');
  expect(__openAICompatProxyTestUtils.normalizeProviderModelId('MiniMax-M3.0', 'openai')).toBe('MiniMax-M3.0');
});

test('sanitizeToolsForGemini removes unsupported schema keys', () => {
  const request = {
    tools: [
      {
        type: 'function',
        function: {
          name: 'lookup',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              query: {
                type: 'string',
                format: 'uri',
                description: 'Search query',
              },
            },
          },
        },
      },
    ],
  };

  __openAICompatProxyTestUtils.sanitizeToolsForGemini(request, 'gemini');

  expect(request.tools[0].function.parameters).toEqual({
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query',
      },
    },
  });
});
