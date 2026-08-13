import { describe, it, expect } from 'vitest';
import {
  parseSqlResponse,
  parseOpenAIModels,
  parseAnthropicModels,
  parseGeminiModels,
} from '../client';

describe('parseSqlResponse', () => {
  it('extracts a fenced ```sql block and uses the rest as explanation', () => {
    const raw = [
      'Here is your query:',
      '```sql',
      'SELECT id, email FROM users LIMIT 10;',
      '```',
      'This returns the first ten users.',
    ].join('\n');

    const result = parseSqlResponse(raw);
    expect(result.sql).toBe('SELECT id, email FROM users LIMIT 10;');
    expect(result.explanation).toContain('Here is your query:');
    expect(result.explanation).toContain('first ten users');
    // The SQL block must NOT appear in the explanation.
    expect(result.explanation).not.toContain('SELECT id');
  });

  it('handles a fenced block without the sql language tag', () => {
    const raw = ['```', 'SELECT 1;', '```', 'Done.'].join('\n');
    const result = parseSqlResponse(raw);
    expect(result.sql).toBe('SELECT 1;');
    expect(result.explanation).toBe('Done.');
  });

  it('handles uppercase SQL fence tag', () => {
    const raw = ['```SQL', 'DROP TABLE temp;', '```'].join('\n');
    const result = parseSqlResponse(raw);
    expect(result.sql).toBe('DROP TABLE temp;');
  });

  it('treats bare SQL-looking text as SQL when no fence is present', () => {
    const raw = 'select * from orders where status = \'paid\'';
    const result = parseSqlResponse(raw);
    expect(result.sql).toBe(raw);
    expect(result.explanation).toBe('');
  });

  it('treats non-SQL prose (no fence) as explanation with empty sql', () => {
    const raw = 'I cannot help with that request.';
    const result = parseSqlResponse(raw);
    expect(result.sql).toBe('');
    expect(result.explanation).toBe(raw);
  });

  it('handles a multi-statement SQL block', () => {
    const raw = [
      '```sql',
      'CREATE INDEX idx_users_email ON users(email);',
      'ANALYZE users;',
      '```',
    ].join('\n');
    const result = parseSqlResponse(raw);
    expect(result.sql).toContain('CREATE INDEX');
    expect(result.sql).toContain('ANALYZE users;');
  });
});

describe('parseOpenAIModels', () => {
  it('maps the standard { data: [{ id, owned_by }] } shape', () => {
    const data = {
      data: [
        { id: 'gpt-4o', owned_by: 'openai' },
        { id: 'gpt-4o-mini', owned_by: 'openai' },
      ],
    };
    const result = parseOpenAIModels(data);
    expect(result).toEqual([
      { id: 'gpt-4o', ownedBy: 'openai', label: undefined },
      { id: 'gpt-4o-mini', ownedBy: 'openai', label: undefined },
    ]);
  });

  it('uses the name field as label when present (OpenRouter shape)', () => {
    const data = {
      data: [
        { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
      ],
    };
    const result = parseOpenAIModels(data);
    expect(result[0]).toEqual({
      id: 'anthropic/claude-3.5-sonnet',
      label: 'Claude 3.5 Sonnet',
      ownedBy: undefined,
    });
  });

  it('filters out entries without an id', () => {
    const data = { data: [{ id: 'gpt-4o' }, { owned_by: 'x' }, { id: '' }] };
    const result = parseOpenAIModels(data);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('gpt-4o');
  });

  it('returns [] for malformed payloads', () => {
    expect(parseOpenAIModels({})).toEqual([]);
    expect(parseOpenAIModels(null)).toEqual([]);
    expect(parseOpenAIModels({ data: 'not-an-array' })).toEqual([]);
  });
});

describe('parseAnthropicModels', () => {
  it('maps { data: [{ id, display_name }] }', () => {
    const data = {
      data: [
        { id: 'claude-3-5-sonnet-20241022', display_name: 'Claude 3.5 Sonnet' },
        { id: 'claude-3-opus-20240229', display_name: 'Claude 3 Opus' },
      ],
    };
    const result = parseAnthropicModels(data);
    expect(result).toEqual([
      { id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
      { id: 'claude-3-opus-20240229', label: 'Claude 3 Opus' },
    ]);
  });

  it('returns [] for malformed payloads', () => {
    expect(parseAnthropicModels({ data: [] })).toEqual([]);
    expect(parseAnthropicModels({})).toEqual([]);
  });
});

describe('parseGeminiModels', () => {
  it('maps { models: [{ name: "models/<id>", displayName }] } and strips the prefix', () => {
    const data = {
      models: [
        { name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash' },
        { name: 'models/gemini-1.5-pro', displayName: 'Gemini 1.5 Pro' },
      ],
    };
    const result = parseGeminiModels(data);
    expect(result).toEqual([
      { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
      { id: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
    ]);
  });

  it('filters entries without a usable id', () => {
    const data = { models: [{ name: 'models/gemini-2.0-flash' }, { displayName: 'x' }] };
    const result = parseGeminiModels(data);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('gemini-2.0-flash');
  });

  it('returns [] for malformed payloads', () => {
    expect(parseGeminiModels({})).toEqual([]);
    expect(parseGeminiModels(null)).toEqual([]);
  });
});
