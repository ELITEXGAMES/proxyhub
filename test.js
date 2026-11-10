// Quick test script for the Antigravity proxy
// Run: node test.js

const BASE = 'http://localhost:4000';
const API_KEY = process.argv[2] || '';

async function test() {
  console.log('=== Antigravity Proxy Test ===\n');

  // 1. Health
  console.log('1. Health check...');
  const health = await fetch(`${BASE}/v1/health`);
  console.log('   ', await health.json(), '\n');

  // 2. Models
  console.log('2. List models...');
  const headers = API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {};
  const models = await fetch(`${BASE}/v1/models`, { headers });
  const modelsData = await models.json();
  if (modelsData.error) {
    console.log('   ERROR:', modelsData.error.message, '\n');
  } else {
    console.log(`   Found ${modelsData.data.length} models:`, modelsData.data.map(m => m.id).join(', '), '\n');
  }

  // 3. Chat completion (non-streaming)
  console.log('3. Chat completion (gemini-2.5-flash)...');
  const chatRes = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'Say hello in one sentence.' }],
    }),
  });
  const chatData = await chatRes.json();
  if (chatData.error) {
    console.log('   ERROR:', chatData.error.message, '\n');
  } else {
    console.log('   Model:', chatData.model);
    console.log('   Response:', chatData.choices?.[0]?.message?.content?.slice(0, 200));
    console.log('   Usage:', chatData.usage, '\n');
  }

  // 4. Streaming test
  console.log('4. Streaming chat completion (gemini-2.5-flash)...');
  const streamRes = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: 'gemini-2.5-flash',
      stream: true,
      messages: [{ role: 'user', content: 'Count from 1 to 5.' }],
    }),
  });

  if (!streamRes.ok) {
    console.log('   ERROR:', (await streamRes.json()).error?.message, '\n');
  } else {
    process.stdout.write('   Stream: ');
    const reader = streamRes.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload);
          const text = parsed.choices?.[0]?.delta?.content || '';
          process.stdout.write(text);
          fullText += text;
        } catch {}
      }
    }
    console.log('\n   Stream complete (' + fullText.length + ' chars)\n');
  }

  // 5. Anthropic /v1/messages streaming test (Claude Desktop simulation)
  console.log('5. Anthropic /v1/messages streaming test (Claude simulation)...');
  const claudeRes = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}`, 'x-api-key': API_KEY } : {}),
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      stream: true,
      max_tokens: 1024,
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'hii' }],
    }),
  });

  if (!claudeRes.ok) {
    console.log('   ERROR:', claudeRes.status, await claudeRes.text(), '\n');
  } else {
    process.stdout.write('   Claude Stream: ');
    const reader = claudeRes.body.getReader();
    const decoder = new TextDecoder();
    let claudeText = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        try {
          const parsed = JSON.parse(payload);
          if (parsed.type === 'content_block_delta') {
            const delta = parsed.delta?.text || '';
            process.stdout.write(delta);
            claudeText += delta;
          }
        } catch {}
      }
    }
    console.log('\n   Claude Stream complete (' + claudeText.length + ' chars)\n');
  }

  // 6. Anthropic /v1/messages non-streaming test
  console.log('6. Anthropic /v1/messages non-streaming test...');
  const claudeNonStream = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}`, 'x-api-key': API_KEY } : {}),
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 50,
      messages: [{ role: 'user', content: 'Say "Anthropic non-stream works!" in one sentence.' }],
    }),
  });
  const claudeData = await claudeNonStream.json();
  if (claudeData.error) {
    console.log('   ERROR:', claudeData.error.message, '\n');
  } else {
    console.log('   Response:', claudeData.content?.[0]?.text, '\n');
  }

  // 7. Embeddings test
  console.log('7. Embeddings (/v1/embeddings)...');
  const embedRes = await fetch(`${BASE}/v1/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: 'text-embedding-004',
      input: 'Antigravity proxy high speed embeddings test',
    }),
  });
  const embedData = await embedRes.json();
  if (embedData.error) {
    console.log('   ERROR:', embedData.error.message, '\n');
  } else {
    console.log(`   Dimensions: ${embedData.data?.[0]?.embedding?.length}, Usage:`, embedData.usage, '\n');
  }

  // 8. Legacy completions test
  console.log('8. Legacy text completions (/v1/completions)...');
  const complRes = await fetch(`${BASE}/v1/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: 'auto-fallback',
      prompt: 'Say "Legacy completion OK" in one sentence.',
      max_tokens: 50,
    }),
  });
  const complData = await complRes.json();
  if (complData.error) {
    console.log('   ERROR:', complData.error.message, '\n');
  } else {
    console.log('   Response:', complData.choices?.[0]?.text?.trim(), '\n');
  }

  // 9. Tool calling test (Function Calling)
  console.log('9. Function Calling test (OpenAI /v1/chat/completions with tools)...');
  const toolRes = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'What is the weather in Tokyo right now? Use the get_weather tool.' }],
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get the current weather for a city',
          parameters: {
            type: 'object',
            properties: {
              location: { type: 'string', description: 'City name' },
            },
            required: ['location'],
          },
        },
      }],
    }),
  });
  const toolData = await toolRes.json();
  if (toolData.error) {
    console.log('   ERROR:', toolData.error.message, '\n');
  } else {
    const msg = toolData.choices?.[0]?.message;
    console.log('   Finish reason:', toolData.choices?.[0]?.finish_reason);
    if (msg?.tool_calls) {
      console.log('   Tool call detected:', msg.tool_calls[0].function.name, msg.tool_calls[0].function.arguments);
    } else {
      console.log('   Reply:', msg?.content?.slice(0, 100));
    }
    console.log('');
  }

  // 10. Multi-turn Tool Return test (Tool call -> Tool result loop with schemas containing const/default)
  console.log('10. Multi-turn Tool Result loop (feeding tool output back with complex schema)...');
  const multiTurnRes = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: 'gemini-2.5-flash',
      messages: [
        { role: 'user', content: 'What is the weather in Tokyo?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_test_tokyo_123',
            type: 'function',
            function: {
              name: 'get_weather',
              arguments: '{"location":"Tokyo"}'
            }
          }]
        },
        {
          role: 'tool',
          tool_call_id: 'call_test_tokyo_123',
          content: JSON.stringify({ temperature: 18, condition: 'Sunny with clear skies', city: 'Tokyo' })
        }
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather for location',
          parameters: {
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
            properties: {
              location: { type: 'string', description: 'City name', default: 'Tokyo' },
              unit: { type: 'string', const: 'celsius' }
            },
            required: ['location']
          }
        }
      }]
    })
  });
  const multiTurnData = await multiTurnRes.json();
  if (multiTurnData.error) {
    console.log('   ERROR:', multiTurnData.error.message, '\n');
  } else {
    console.log('   Final response:', multiTurnData.choices?.[0]?.message?.content?.slice(0, 120), '\n');
  }

  console.log('=== All tests done ===');
}

test().catch(e => { console.error('Test failed:', e.message); process.exit(1); });

