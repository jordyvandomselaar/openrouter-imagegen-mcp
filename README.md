# ImageGen MCP Server

An MCP (Model Context Protocol) server for AI image generation and editing using OpenRouter and Google Gemini.

## Features

- **Generate images** from text prompts using Gemini Flash Image Preview
- **Edit existing images** with natural language instructions (e.g., "make the sky orange")
- **S3 image hosting** - upload images to S3-compatible storage (MinIO, Cloudflare R2, etc.) and return public URLs
- **Conversation persistence** - pick up where you left off with saved conversation history
- **Automatic image saving** - all generated images saved to disk with metadata
- **API request logging** - debug logs saved to conversation folders

## Prerequisites

- [Bun](https://bun.sh) runtime (v1.0+)
- [OpenRouter](https://openrouter.ai) API key

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/imagegen-mcp.git
   cd imagegen-mcp
   ```

2. Install dependencies:
   ```bash
   bun install
   ```

3. Get an API key from [OpenRouter](https://openrouter.ai/settings/keys)

## Configuration

### Claude Desktop (Windows)

Add to your Claude Desktop config at `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "imagegen": {
      "command": "bun",
      "args": ["run", "C:\\path\\to\\imagegen-mcp\\index.ts"],
      "env": {
        "OPENROUTER_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

### Claude Desktop (Windows with WSL2)

If running Bun through WSL:

```json
{
  "mcpServers": {
    "imagegen": {
      "command": "wsl",
      "args": ["bun", "run", "/home/user/projects/imagegen-mcp/index.ts"],
      "env": {
        "OPENROUTER_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

### Claude Desktop (macOS/Linux)

```json
{
  "mcpServers": {
    "imagegen": {
      "command": "bun",
      "args": ["run", "/path/to/imagegen-mcp/index.ts"],
      "env": {
        "OPENROUTER_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

## S3 Image Hosting (Optional)

For server deployments (e.g., Coolify, Docker), you can configure S3-compatible storage to host images and return public URLs instead of local file paths.

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `S3_ENDPOINT` | Yes | S3-compatible endpoint URL (e.g., `https://minio.example.com`) |
| `S3_BUCKET` | Yes | Bucket name for storing images |
| `S3_ACCESS_KEY_ID` | Yes | S3 access key ID |
| `S3_SECRET_ACCESS_KEY` | Yes | S3 secret access key |
| `S3_PUBLIC_URL_BASE` | Yes | Public URL base for accessing images (e.g., `https://cdn.example.com/bucket`) |
| `S3_REGION` | No | S3 region (default: `auto`) |
| `S3_PREFIX` | No | Path prefix for uploaded images (default: `images`) |

### Example: Coolify with MinIO

```bash
# In your Coolify environment variables:
OPENROUTER_API_KEY=sk-or-...
S3_ENDPOINT=https://minio.yourdomain.com
S3_BUCKET=imagegen
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
S3_PUBLIC_URL_BASE=https://minio.yourdomain.com/imagegen
S3_REGION=auto
S3_PREFIX=generated
```

### Example: Cloudflare R2

```bash
S3_ENDPOINT=https://your-account-id.r2.cloudflarestorage.com
S3_BUCKET=imagegen
S3_ACCESS_KEY_ID=your-r2-access-key
S3_SECRET_ACCESS_KEY=your-r2-secret-key
S3_PUBLIC_URL_BASE=https://your-r2-public-url.com
```

When S3 is configured, generated images will be uploaded and the tool will return `IMAGE_URL: https://...` instead of `IMAGE_PATH: /local/path/...`.

## Usage

Once configured, the following tools are available in Claude:

### `generate_image`
Create a new image from a text prompt.

**Example:** "Generate an image of a cat sitting on a rainbow"

### `edit_image`
Modify an existing image with natural language instructions. The model receives the previous image and attempts to make only the requested changes.

**Example:** "Make the cat's fur orange" or "Add sunglasses to the cat"

### `handle_generated_image`
Opens the generated image in your system's default image viewer. Called automatically after generation.

### `list_conversations`
View all saved image generation conversations with their IDs and descriptions.

### `clear_conversation`
Delete a specific conversation or all conversations from disk.

## How It Works

1. **Image Generation**: Prompts are sent to Gemini Flash Image Preview via OpenRouter
2. **Image Editing**: The previous image is sent inline with edit instructions for better results
3. **Persistence**: Images saved to `images/{conversation_id}/` with `messages.json` tracking history
4. **Logging**: API requests/responses logged to `request-{timestamp}.json` for debugging

## File Structure

```
imagegen-mcp/
├── index.ts          # Main MCP server
├── images/           # Generated images and conversation data
│   └── {conv-id}/
│       ├── *.png           # Generated images
│       ├── messages.json   # Conversation history
│       ├── README.md       # Conversation summary
│       └── request-*.json  # API logs
├── package.json
└── tsconfig.json
```

## Development

Run the server directly:
```bash
OPENROUTER_API_KEY=your-key bun run index.ts
```

## License

MIT
