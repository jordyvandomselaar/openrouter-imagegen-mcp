# ImageGen MCP Server

An MCP server for AI image generation using OpenRouter.

## Setup

1. Get an API key from https://openrouter.ai/settings/keys
2. Set the `OPENROUTER_API_KEY` environment variable

## Running

```sh
bun run index.ts
```

## MCP Configuration (Windows with WSL2)

Add to your Claude Desktop config (`%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "imagegen": {
      "command": "wsl",
      "args": ["bun", "run", "/home/jordy/projects/imagegen-mcp/index.ts"],
      "env": {
        "OPENROUTER_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

## Tools

- `generate_image` - Generate images from text prompts. Supports iterative refinement via conversation IDs.
- `list_conversations` - List active image generation conversations
- `clear_conversation` - Clear conversation history

## Bun Notes

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun install` instead of `npm install`
- Bun automatically loads .env, so don't use dotenv.
