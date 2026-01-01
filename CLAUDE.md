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

## S3 Image Hosting (for server deployments)

For hosting on Coolify or similar, configure S3-compatible storage:

```sh
S3_ENDPOINT=https://minio.example.com
S3_BUCKET=imagegen
S3_ACCESS_KEY_ID=your-key
S3_SECRET_ACCESS_KEY=your-secret
S3_PUBLIC_URL_BASE=https://minio.example.com/imagegen
S3_REGION=auto        # optional
S3_PREFIX=images      # optional
```

When S3 is configured, images are uploaded and URLs are returned instead of local paths.

## Tools

- `generate_image` - Generate images from text prompts. Returns IMAGE_URL (S3) or IMAGE_PATH (local).
- `edit_image` - Edit existing images with natural language instructions.
- `handle_generated_image` - Process generated images (share URL or open locally).
- `list_conversations` - List active image generation conversations
- `clear_conversation` - Clear conversation history

## Bun Notes

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun install` instead of `npm install`
- Bun automatically loads .env, so don't use dotenv.
