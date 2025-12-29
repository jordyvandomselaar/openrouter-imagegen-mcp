# ImageGen MCP Server

An MCP (Model Context Protocol) server for AI image generation and editing using OpenRouter and Google Gemini.

## Features

- **Generate images** from text prompts using Gemini Flash Image Preview
- **Edit existing images** with natural language instructions (e.g., "make the sky orange")
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
