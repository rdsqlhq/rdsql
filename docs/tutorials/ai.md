# AI Assistant

## Purpose

Generate SQL from natural language, optimize existing queries, and get a
schema explained, using an AI provider of your choice.

## Requirements

- An API key for a supported provider: **OpenAI**, **Anthropic**, **Gemini**,
  **z.ai**, **OpenRouter**, or any custom OpenAI-compatible endpoint.

## Steps

1. Open **Settings → AI** and add your API token for one of the supported
   providers (or a custom base URL for a compatible endpoint).
2. Open the **AI Assistant** panel from a connection or SQL editor tab.
3. Ask for what you need in plain language — e.g. "show me the 10 most
   recent orders with their customer name", or paste a slow query and ask
   for optimization suggestions.
4. Review the generated SQL before running it — the assistant proposes
   queries, it doesn't execute them without you choosing to run them.

## Expected result

A working SQL query (or an explanation/optimization suggestion) grounded in
the connected database's actual schema.

## Troubleshooting

- **"No AI provider is configured yet"** — add an API token in
  **Settings → AI** first; the assistant is inert until a provider is set.
- **Generated SQL references the wrong table/column names** — make sure the
  schema has finished loading for that connection before asking; very large
  schemas may take a moment to index.
- **Custom endpoint doesn't respond** — confirm the base URL is
  OpenAI-compatible and reachable from your machine.
