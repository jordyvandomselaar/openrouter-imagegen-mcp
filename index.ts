#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Create images folder in the MCP directory
const __dirname = dirname(fileURLToPath(import.meta.url));
const IMAGE_DIR = join(__dirname, "images");
try {
  mkdirSync(IMAGE_DIR, { recursive: true });
} catch {}
console.error(`Image output directory: ${IMAGE_DIR}`);

// Store conversation history for iterative image generation
interface ConversationMessage {
  role: "user" | "assistant";
  content: string | Array<{ type: string; text?: string; image_url?: { url: string }; image_path?: string }>;
}

const conversations = new Map<string, ConversationMessage[]>();

// Load existing conversations from disk on startup
function loadConversationsFromDisk() {
  try {
    const dirs = readdirSync(IMAGE_DIR, { withFileTypes: true });
    for (const dir of dirs) {
      if (dir.isDirectory()) {
        const convId = dir.name;
        const messagesPath = join(IMAGE_DIR, convId, "messages.json");
        if (existsSync(messagesPath)) {
          const data = readFileSync(messagesPath, "utf-8");
          conversations.set(convId, JSON.parse(data));
          console.error(`Loaded conversation: ${convId}`);
        }
      }
    }
    console.error(`Loaded ${conversations.size} conversations from disk`);
  } catch (err) {
    console.error(`Error loading conversations: ${err}`);
  }
}

// Save conversation to disk
function saveConversationToDisk(convId: string, messages: ConversationMessage[], firstPrompt: string) {
  const convDir = join(IMAGE_DIR, convId);
  try {
    mkdirSync(convDir, { recursive: true });
  } catch {}

  // Save messages as JSON
  writeFileSync(join(convDir, "messages.json"), JSON.stringify(messages, null, 2));

  // Create/update README.md with description
  const readmePath = join(convDir, "README.md");
  const imageFiles = readdirSync(convDir).filter(f => /\.(png|jpg|jpeg|gif|webp)$/i.test(f));

  let readme = `# Image Generation Conversation\n\n`;
  readme += `**ID:** ${convId}\n\n`;
  readme += `**Initial Prompt:** ${firstPrompt}\n\n`;
  readme += `**Messages:** ${messages.length}\n\n`;
  readme += `**Images:** ${imageFiles.length}\n\n`;

  if (imageFiles.length > 0) {
    readme += `## Generated Images\n\n`;
    for (const img of imageFiles) {
      readme += `![${img}](./${img})\n\n`;
    }
  }

  writeFileSync(readmePath, readme);
}

// Get first user prompt from messages
function getFirstPrompt(messages: ConversationMessage[]): string {
  const firstUser = messages.find(m => m.role === "user");
  if (!firstUser) return "Unknown";
  return typeof firstUser.content === "string"
    ? firstUser.content.substring(0, 100)
    : "Image conversation";
}

// Convert stored messages to API format (read images from disk)
function messagesToApiFormat(messages: ConversationMessage[]): Array<{ role: string; content: any }> {
  return messages.map(m => {
    if (typeof m.content === "string") {
      return { role: m.role, content: m.content };
    }

    // Convert content array, reading images from disk
    const apiContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

    for (const item of m.content) {
      if (item.type === "text" && item.text) {
        apiContent.push({ type: "text", text: item.text });
      } else if (item.type === "image_url" && (item as any).image_path) {
        // Read image from disk and convert to base64
        const imagePath = join(IMAGE_DIR, (item as any).image_path);
        try {
          if (existsSync(imagePath)) {
            const imageBuffer = readFileSync(imagePath);
            const base64 = imageBuffer.toString("base64");
            const ext = imagePath.split(".").pop()?.toLowerCase() || "png";
            const mimeType = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
            apiContent.push({
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${base64}` }
            });
          } else {
            console.error(`Image file not found: ${imagePath}`);
          }
        } catch (err) {
          console.error(`Error reading image: ${err}`);
        }
      } else if (item.type === "image_url" && item.image_url?.url) {
        // Legacy: already has a URL (for backwards compatibility)
        apiContent.push({ type: "image_url", image_url: item.image_url });
      }
    }

    return { role: m.role, content: apiContent.length > 0 ? apiContent : "" };
  });
}

// Log API request to conversation folder (omit API key, truncate base64)
function logApiRequest(convDir: string, requestBody: any, response: any) {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logPath = join(convDir, `request-${timestamp}.json`);

    // Sanitize request: truncate base64 data for readability
    const sanitizeContent = (content: any): any => {
      if (typeof content === 'string') {
        if (content.length > 500 && content.includes('base64')) {
          return content.substring(0, 100) + `... [TRUNCATED ${content.length} chars]`;
        }
        return content;
      }
      if (Array.isArray(content)) {
        return content.map(sanitizeContent);
      }
      if (content && typeof content === 'object') {
        const sanitized: any = {};
        for (const key of Object.keys(content)) {
          if (key === 'image_url' && content[key]?.url?.length > 500) {
            sanitized[key] = { url: `[BASE64 IMAGE - ${content[key].url.length} chars]` };
          } else {
            sanitized[key] = sanitizeContent(content[key]);
          }
        }
        return sanitized;
      }
      return content;
    };

    const logData = {
      timestamp: new Date().toISOString(),
      request: {
        model: requestBody.model,
        modalities: requestBody.modalities,
        messages: requestBody.messages.map((m: any) => ({
          role: m.role,
          content: sanitizeContent(m.content),
        })),
      },
      response: {
        id: response.id,
        model: response.model,
        provider: response.provider,
        usage: response.usage,
        choices: response.choices?.map((c: any) => ({
          finish_reason: c.finish_reason,
          message: {
            role: c.message?.role,
            content: sanitizeContent(c.message?.content),
            // Note if images were present
            has_images: !!(c.message?.images?.length),
            image_count: c.message?.images?.length || 0,
          },
        })),
      },
    };

    writeFileSync(logPath, JSON.stringify(logData, null, 2));
    console.error(`Logged API request to: ${logPath}`);
  } catch (err) {
    console.error(`Failed to log API request: ${err}`);
  }
}

// Get API key
function getApiKey(): string {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY environment variable is required. " +
      "Get your API key from https://openrouter.ai/settings/keys"
    );
  }
  return apiKey;
}

// Create MCP server
const server = new McpServer({
  name: "imagegen-mcp",
  version: "1.0.0",
});

// Tool: Generate image (NEW images only)
server.tool(
  "generate_image",
  `Generate a NEW image from a text prompt. Use this for creating the first image in a conversation.

IMPORTANT: After this tool completes, you MUST call handle_generated_image with the returned image_path and conversation_id.

Do NOT use this tool to edit existing images - use edit_image instead.`,
  {
    prompt: z.string().describe("A full description of the image to generate. Be detailed about the scene, style, colors, composition, etc."),
  },
  async ({ prompt }) => {
    const apiKey = getApiKey();
    const selectedModel = "google/gemini-2.5-flash-image-preview";
    const conversation_id = undefined; // New conversation

    // Get or create conversation
    const convId = conversation_id || crypto.randomUUID();
    let messages = conversations.get(convId) || [];
    const isNewConversation = messages.length === 0;

    // Create conversation directory
    const convDir = join(IMAGE_DIR, convId);
    try {
      mkdirSync(convDir, { recursive: true });
    } catch {}

    // Add user message
    messages.push({
      role: "user",
      content: prompt,
    });

    try {
      // Build request body
      const requestBody = {
        model: selectedModel,
        messages: messagesToApiFormat(messages),
        modalities: ["image", "text"],
      };

      // Use fetch directly to avoid SDK stripping image data
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error: ${response.status} ${errorText}`);
      }

      const result = await response.json();

      // Log request and response to conversation folder
      logApiRequest(convDir, requestBody, result);

      const assistantMessage = result.choices[0]?.message;
      if (!assistantMessage) {
        throw new Error("No response from model");
      }

      // Build response content
      const responseContent: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];

      // Add text response if present (filter out <image> placeholder)
      const rawTextContent = assistantMessage.content;
      const textContent = typeof rawTextContent === "string" && rawTextContent.trim() && rawTextContent.trim() !== "<image>"
        ? rawTextContent.trim()
        : null;
      if (textContent) {
        responseContent.push({
          type: "text",
          text: textContent,
        });
      }

      // Debug: log full response structure
      console.error(`Full result structure: ${JSON.stringify(result, null, 2).substring(0, 5000)}`);
      console.error(`Assistant message: ${JSON.stringify(assistantMessage, null, 2).substring(0, 3000)}`);

      // Process images - check multiple possible locations
      let images: any[] | null = null;

      // Log all keys at every level for debugging
      console.error(`Result keys: ${Object.keys(result).join(', ')}`);
      console.error(`Choices[0] keys: ${result.choices?.[0] ? Object.keys(result.choices[0]).join(', ') : 'N/A'}`);
      console.error(`Assistant message keys: ${Object.keys(assistantMessage).join(', ')}`);

      // Check 1: Direct images field on assistant message
      if ((assistantMessage as any).images) {
        images = (assistantMessage as any).images;
        console.error(`Found images in assistantMessage.images: ${images?.length}`);
      }

      // Check 2: Images in content array (when content is an array)
      if (!images && Array.isArray(assistantMessage.content)) {
        const imageItems = (assistantMessage.content as any[]).filter((c: any) =>
          c.type === 'image' || c.type === 'image_url' || c.image_url || c.data || c.inline_data
        );
        if (imageItems.length > 0) {
          images = imageItems;
          console.error(`Found images in content array: ${images?.length}`);
        }
      }

      // Check 3: Images at top level of result
      if (!images && (result as any).images) {
        images = (result as any).images;
        console.error(`Found images in result.images: ${images?.length}`);
      }

      // Check 4: Images in choices[0] directly
      if (!images && (result.choices[0] as any)?.images) {
        images = (result.choices[0] as any).images;
        console.error(`Found images in choices[0].images: ${images?.length}`);
      }

      // Check 5: Gemini-style inline_data in message parts
      if (!images && (assistantMessage as any).parts) {
        const parts = (assistantMessage as any).parts;
        const imageItems = parts.filter((p: any) => p.inline_data || p.inlineData);
        if (imageItems.length > 0) {
          images = imageItems.map((p: any) => p.inline_data || p.inlineData);
          console.error(`Found images in message.parts: ${images?.length}`);
        }
      }

      // Check 6: Check result.data (some APIs use this)
      if (!images && (result as any).data?.images) {
        images = (result as any).data.images;
        console.error(`Found images in result.data.images: ${images?.length}`);
      }

      // Check 7: OpenRouter specific - check for image in output
      if (!images && (result.choices[0] as any)?.message?.output) {
        const output = (result.choices[0] as any).message.output;
        if (Array.isArray(output)) {
          const imageItems = output.filter((o: any) => o.type === 'image' || o.image || o.data);
          if (imageItems.length > 0) {
            images = imageItems;
            console.error(`Found images in message.output: ${images?.length}`);
          }
        }
      }

      console.error(`Response has images: ${images ? 'yes (' + images.length + ')' : 'no'}`);

      if (images && Array.isArray(images) && images.length > 0) {
        // Store assistant response with images for conversation history
        const assistantContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

        if (textContent) {
          assistantContent.push({ type: "text", text: textContent });
        }

        for (const image of images) {
          // Handle different image formats from various APIs
          console.error(`Image object keys: ${Object.keys(image).join(', ')}`);
          console.error(`Image object sample: ${JSON.stringify(image).substring(0, 200)}`);

          // Try multiple formats: OpenRouter, OpenAI, Gemini, etc.
          let imageUrl: string | null = null;

          // Format 1: imageUrl.url (OpenRouter SDK style)
          if (image.imageUrl?.url) imageUrl = image.imageUrl.url;
          // Format 2: image_url.url (OpenAI style)
          else if (image.image_url?.url) imageUrl = image.image_url.url;
          // Format 3: direct url
          else if (image.url) imageUrl = image.url;
          // Format 4: base64 data directly on object
          else if (image.data && typeof image.data === 'string') {
            const mimeType = image.mimeType || image.mime_type || 'image/png';
            imageUrl = `data:${mimeType};base64,${image.data}`;
          }
          // Format 5: b64_json (OpenAI DALL-E style)
          else if (image.b64_json) {
            imageUrl = `data:image/png;base64,${image.b64_json}`;
          }

          console.error(`Processing image: ${imageUrl ? imageUrl.substring(0, 100) + '...' : 'no url found'}`);
          if (imageUrl) {
            let savedFilepath: string | null = null;
            let imageBase64: string | null = null;
            let imageMimeType = "image/png";

            // Handle base64 data URLs
            if (imageUrl.startsWith("data:")) {
              const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
              if (match) {
                imageMimeType = match[1];
                imageBase64 = match[2];
                const extension = imageMimeType.split("/")[1] || "png";
                const filename = `${Date.now()}.${extension}`;
                savedFilepath = join(convDir, filename);

                // Save image to conversation folder
                const imageBuffer = Buffer.from(imageBase64, "base64");
                writeFileSync(savedFilepath, imageBuffer);
                console.error(`Saved image: ${savedFilepath} (${(imageBuffer.length / 1024).toFixed(1)}KB)`);
              }
            } else {
              // For regular URLs, fetch and save to file
              try {
                const fetchResp = await fetch(imageUrl);
                const buffer = await fetchResp.arrayBuffer();
                const contentType = fetchResp.headers.get("content-type") || "image/png";
                imageMimeType = contentType;
                const extension = contentType.split("/")[1] || "png";
                const filename = `${Date.now()}.${extension}`;
                savedFilepath = join(convDir, filename);

                // Save image to conversation folder
                const imageBuffer = Buffer.from(buffer);
                writeFileSync(savedFilepath, imageBuffer);
                imageBase64 = imageBuffer.toString("base64");
                console.error(`Saved image: ${savedFilepath} (${(buffer.byteLength / 1024).toFixed(1)}KB)`);
              } catch (fetchError) {
                console.error(`Failed to fetch image: ${fetchError}`);
              }
            }

            // If we saved the image, add it to the response and conversation history
            if (savedFilepath) {
              // Only return the file path - no base64 in response
              responseContent.push({
                type: "text",
                text: `IMAGE_PATH: ${savedFilepath}`,
              });

              // Store file path (not base64) in conversation history for smaller JSON
              // Use relative path from IMAGE_DIR for portability
              const relativePath = savedFilepath.replace(IMAGE_DIR + (process.platform === "win32" ? "\\" : "/"), "");
              assistantContent.push({
                type: "image_url",
                image_path: relativePath,
              } as any);
            }
          }
        }

        // Store in conversation history
        messages.push({
          role: "assistant",
          content: assistantContent.length > 0 ? assistantContent : (textContent || ""),
        });
      } else {
        // No images, just store text
        console.error(`No images found in response. Full message: ${JSON.stringify(assistantMessage).substring(0, 500)}`);
        messages.push({
          role: "assistant",
          content: textContent || "",
        });
      }

      // Save conversation to memory and disk
      conversations.set(convId, messages);
      saveConversationToDisk(convId, messages, getFirstPrompt(messages));

      // Add conversation ID info
      responseContent.push({
        type: "text",
        text: `\n\n---\nConversation ID: ${convId}\nUse this ID to iterate on this image with follow-up prompts.`,
      });

      return {
        content: responseContent,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: `Error generating image: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: Edit image (iterate on existing images)
server.tool(
  "edit_image",
  `Request a new version of an image with changes. The model receives the previous image as context.

IMPORTANT: After this tool completes, you MUST call handle_generated_image with the returned image_path and conversation_id.

NOTE: The model generates a new image inspired by your description and the previous image. Results may vary - some edits work well, others may produce a different image. For best results, be specific about what to keep and what to change.

Good prompts:
- "Make the sky orange but keep the cat exactly the same"
- "Add a small rainbow in the top right corner"
- "Change only the cat's color to red, keep everything else identical"`,
  {
    conversation_id: z.string().describe("The conversation ID from a previous generate_image or edit_image call"),
    prompt: z.string().describe("Describe what to CHANGE about the image. E.g., 'make the background blue', 'add a rainbow', 'remove the person on the left'"),
  },
  async ({ conversation_id, prompt }) => {
    const apiKey = getApiKey();
    const selectedModel = "google/gemini-2.5-flash-image-preview";

    // Get existing conversation
    let messages = conversations.get(conversation_id);
    if (!messages || messages.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Conversation ${conversation_id} not found. Use generate_image first to create a new image.`,
          },
        ],
        isError: true,
      };
    }

    const convId = conversation_id;
    const convDir = join(IMAGE_DIR, convId);

    // Find the most recent image from conversation history
    let lastImagePath: string | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if ((item as any).image_path) {
            lastImagePath = (item as any).image_path;
            break;
          }
        }
        if (lastImagePath) break;
      }
    }

    // Build the edit request with image inline in the user message
    // This may work better than relying on conversation history
    const editContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

    // Add the previous image inline
    if (lastImagePath) {
      const imagePath = join(IMAGE_DIR, lastImagePath);
      if (existsSync(imagePath)) {
        const imageBuffer = readFileSync(imagePath);
        const base64 = imageBuffer.toString("base64");
        const ext = imagePath.split(".").pop()?.toLowerCase() || "png";
        const mimeType = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
        editContent.push({
          type: "image_url",
          image_url: { url: `data:${mimeType};base64,${base64}` }
        });
      }
    }

    // Add the edit instruction - be very explicit about preserving everything else
    editContent.push({
      type: "text",
      text: `Edit this image with ONLY this change: ${prompt}

CRITICAL: You must keep EVERYTHING else in the image EXACTLY the same. Do not change:
- The composition or layout
- The background
- Any other objects or elements
- The style or lighting
- Colors of anything not explicitly mentioned

Only make the specific change requested above. The output should be identical to the input except for that one change.`,
    });

    // Add user edit message to conversation history
    messages.push({
      role: "user",
      content: `Edit request: ${prompt}`,
    });

    try {
      // Build request body - send just the edit request with image inline
      // instead of full conversation history
      const requestBody = {
        model: selectedModel,
        messages: [
          {
            role: "user",
            content: editContent,
          }
        ],
        modalities: ["image", "text"],
      };

      const responseContent: Array<{ type: "text"; text: string }> = [];

      // Use fetch directly to avoid SDK stripping image data
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error: ${response.status} ${errorText}`);
      }

      const result = await response.json();

      // Log request and response to conversation folder
      logApiRequest(convDir, requestBody, result);

      const assistantMessage = result.choices[0]?.message;
      if (!assistantMessage) {
        throw new Error("No response from model");
      }

      // Add text response if present (filter out <image> placeholder)
      const rawTextContent = assistantMessage.content;
      const textContent = typeof rawTextContent === "string" && rawTextContent.trim() && rawTextContent.trim() !== "<image>"
        ? rawTextContent.trim()
        : null;
      if (textContent) {
        responseContent.push({
          type: "text",
          text: textContent,
        });
      }

      // Debug: log full response structure
      console.error(`[edit_image] Full result structure: ${JSON.stringify(result, null, 2).substring(0, 5000)}`);
      console.error(`[edit_image] Assistant message: ${JSON.stringify(assistantMessage, null, 2).substring(0, 3000)}`);

      // Process images - check multiple possible locations
      let images: any[] | null = null;

      // Log all keys at every level for debugging
      console.error(`[edit_image] Result keys: ${Object.keys(result).join(', ')}`);
      console.error(`[edit_image] Choices[0] keys: ${result.choices?.[0] ? Object.keys(result.choices[0]).join(', ') : 'N/A'}`);
      console.error(`[edit_image] Assistant message keys: ${Object.keys(assistantMessage).join(', ')}`);

      // Check 1: Direct images field on assistant message
      if ((assistantMessage as any).images) {
        images = (assistantMessage as any).images;
        console.error(`[edit_image] Found images in assistantMessage.images: ${images?.length}`);
      }

      // Check 2: Images in content array (when content is an array)
      if (!images && Array.isArray(assistantMessage.content)) {
        const imageItems = (assistantMessage.content as any[]).filter((c: any) =>
          c.type === 'image' || c.type === 'image_url' || c.image_url || c.data || c.inline_data
        );
        if (imageItems.length > 0) {
          images = imageItems;
          console.error(`[edit_image] Found images in content array: ${images?.length}`);
        }
      }

      // Check 3: Images at top level of result
      if (!images && (result as any).images) {
        images = (result as any).images;
        console.error(`[edit_image] Found images in result.images: ${images?.length}`);
      }

      // Check 4: Images in choices[0] directly
      if (!images && (result.choices[0] as any)?.images) {
        images = (result.choices[0] as any).images;
        console.error(`[edit_image] Found images in choices[0].images: ${images?.length}`);
      }

      // Check 5: Gemini-style inline_data in message parts
      if (!images && (assistantMessage as any).parts) {
        const parts = (assistantMessage as any).parts;
        const imageItems = parts.filter((p: any) => p.inline_data || p.inlineData);
        if (imageItems.length > 0) {
          images = imageItems.map((p: any) => p.inline_data || p.inlineData);
          console.error(`[edit_image] Found images in message.parts: ${images?.length}`);
        }
      }

      // Check 6: Check result.data (some APIs use this)
      if (!images && (result as any).data?.images) {
        images = (result as any).data.images;
        console.error(`[edit_image] Found images in result.data.images: ${images?.length}`);
      }

      // Check 7: OpenRouter specific - check for image in output
      if (!images && (result.choices[0] as any)?.message?.output) {
        const output = (result.choices[0] as any).message.output;
        if (Array.isArray(output)) {
          const imageItems = output.filter((o: any) => o.type === 'image' || o.image || o.data);
          if (imageItems.length > 0) {
            images = imageItems;
            console.error(`[edit_image] Found images in message.output: ${images?.length}`);
          }
        }
      }

      console.error(`[edit_image] Response has images: ${images ? 'yes (' + images.length + ')' : 'no'}`);

      if (images && Array.isArray(images) && images.length > 0) {
        const assistantContent: Array<{ type: string; text?: string; image_path?: string }> = [];

        if (textContent) {
          assistantContent.push({ type: "text", text: textContent });
        }

        for (const image of images) {
          let imageUrl: string | null = null;

          if (image.imageUrl?.url) imageUrl = image.imageUrl.url;
          else if (image.image_url?.url) imageUrl = image.image_url.url;
          else if (image.url) imageUrl = image.url;
          else if (image.data && typeof image.data === 'string') {
            const mimeType = image.mimeType || image.mime_type || 'image/png';
            imageUrl = `data:${mimeType};base64,${image.data}`;
          }
          else if (image.b64_json) {
            imageUrl = `data:image/png;base64,${image.b64_json}`;
          }

          if (imageUrl) {
            let savedFilepath: string | null = null;

            if (imageUrl.startsWith("data:")) {
              const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
              if (match) {
                const mimeType = match[1];
                const base64Data = match[2];
                const extension = mimeType.split("/")[1] || "png";
                const filename = `${Date.now()}.${extension}`;
                savedFilepath = join(convDir, filename);

                const imageBuffer = Buffer.from(base64Data, "base64");
                writeFileSync(savedFilepath, imageBuffer);
                console.error(`Saved edited image: ${savedFilepath} (${(imageBuffer.length / 1024).toFixed(1)}KB)`);
              }
            } else {
              try {
                const fetchResp = await fetch(imageUrl);
                const buffer = await fetchResp.arrayBuffer();
                const contentType = fetchResp.headers.get("content-type") || "image/png";
                const extension = contentType.split("/")[1] || "png";
                const filename = `${Date.now()}.${extension}`;
                savedFilepath = join(convDir, filename);

                const imageBuffer = Buffer.from(buffer);
                writeFileSync(savedFilepath, imageBuffer);
                console.error(`Saved edited image: ${savedFilepath} (${(buffer.byteLength / 1024).toFixed(1)}KB)`);
              } catch (fetchError) {
                console.error(`Failed to fetch image: ${fetchError}`);
              }
            }

            if (savedFilepath) {
              responseContent.push({
                type: "text",
                text: `IMAGE_PATH: ${savedFilepath}`,
              });

              const relativePath = savedFilepath.replace(IMAGE_DIR + (process.platform === "win32" ? "\\" : "/"), "");
              assistantContent.push({
                type: "image_url",
                image_path: relativePath,
              } as any);
            }
          }
        }

        messages.push({
          role: "assistant",
          content: assistantContent.length > 0 ? assistantContent : (textContent || ""),
        });
      } else {
        messages.push({
          role: "assistant",
          content: textContent || "",
        });
      }

      // Save conversation
      conversations.set(convId, messages);
      saveConversationToDisk(convId, messages, getFirstPrompt(messages));

      responseContent.push({
        type: "text",
        text: `\n\n---\nConversation ID: ${convId}\nUse edit_image with this ID to make more changes.`,
      });

      return {
        content: responseContent,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: `Error editing image: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: Handle generated image (follow-up action after generate_image or edit_image)
server.tool(
  "handle_generated_image",
  `Process a generated image. This tool MUST be called after generate_image or edit_image completes.

Instructions for the assistant:
1. Open the image using the system viewer so the user can see it
2. Ask the user if they would like to make any changes to the image
3. If the user wants changes, use edit_image with the conversation_id to iterate`,
  {
    image_path: z.string().describe("The full path to the generated image file"),
    conversation_id: z.string().describe("The conversation ID for this image generation session"),
  },
  async ({ image_path, conversation_id }) => {
    if (!existsSync(image_path)) {
      return {
        content: [{ type: "text", text: `File not found: ${image_path}` }],
        isError: true,
      };
    }

    try {
      // Open with default app based on platform
      const { exec } = await import("child_process");
      const command = process.platform === "win32"
        ? `start "" "${image_path}"`
        : process.platform === "darwin"
        ? `open "${image_path}"`
        : `xdg-open "${image_path}"`;

      exec(command, (error) => {
        if (error) {
          console.error(`Failed to open image: ${error}`);
        }
      });

      return {
        content: [
          {
            type: "text",
            text: `Image opened: ${image_path}\n\nConversation ID: ${conversation_id}\n\nAsk the user if they'd like to make any changes to the image. If yes, use edit_image with this conversation_id to iterate.`,
          },
        ],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Failed to open image: ${e}` }],
        isError: true,
      };
    }
  }
);

// Tool: Show image (legacy, kept for backwards compatibility)
server.tool(
  "show_image",
  "Open an image file with the default system image viewer.",
  {
    image_path: z.string().describe("The full path to the image file to display"),
  },
  async ({ image_path }) => {
    if (!existsSync(image_path)) {
      return {
        content: [{ type: "text", text: `File not found: ${image_path}` }],
        isError: true,
      };
    }

    try {
      // Open with default app based on platform
      const { exec } = await import("child_process");
      const command = process.platform === "win32"
        ? `start "" "${image_path}"`
        : process.platform === "darwin"
        ? `open "${image_path}"`
        : `xdg-open "${image_path}"`;

      exec(command, (error) => {
        if (error) {
          console.error(`Failed to open image: ${error}`);
        }
      });

      return {
        content: [
          {
            type: "text",
            text: `Opened image: ${image_path}`,
          },
        ],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Failed to open image: ${e}` }],
        isError: true,
      };
    }
  }
);

// Tool: List conversations
server.tool(
  "list_conversations",
  "List all image generation conversations (persisted to disk). Returns conversation IDs and descriptions.",
  {},
  async () => {
    // Read from disk to get all conversations (including from previous sessions)
    const convList: string[] = [];

    try {
      const dirs = readdirSync(IMAGE_DIR, { withFileTypes: true });
      for (const dir of dirs) {
        if (dir.isDirectory()) {
          const convId = dir.name;
          const readmePath = join(IMAGE_DIR, convId, "README.md");
          const messagesPath = join(IMAGE_DIR, convId, "messages.json");

          let description = "No description";
          let messageCount = 0;
          let imageCount = 0;

          // Read README for description
          if (existsSync(readmePath)) {
            const readme = readFileSync(readmePath, "utf-8");
            const promptMatch = readme.match(/\*\*Initial Prompt:\*\* (.+)/);
            if (promptMatch) {
              description = promptMatch[1].substring(0, 50);
              if (promptMatch[1].length > 50) description += "...";
            }
          }

          // Count messages
          if (existsSync(messagesPath)) {
            const messages = JSON.parse(readFileSync(messagesPath, "utf-8"));
            messageCount = messages.length;
          }

          // Count images
          const files = readdirSync(join(IMAGE_DIR, convId));
          imageCount = files.filter(f => /\.(png|jpg|jpeg|gif|webp)$/i.test(f)).length;

          convList.push(`- **${convId}**\n  "${description}" (${messageCount} messages, ${imageCount} images)`);
        }
      }
    } catch (err) {
      console.error(`Error listing conversations: ${err}`);
    }

    return {
      content: [
        {
          type: "text",
          text: convList.length > 0
            ? `## Saved Conversations\n\n${convList.join("\n\n")}`
            : "No saved conversations. Start a new one with generate_image.",
        },
      ],
    };
  }
);

// Tool: Clear conversation
server.tool(
  "clear_conversation",
  "Clear a specific conversation or all conversations (removes from disk).",
  {
    conversation_id: z.string().optional().describe(
      "The conversation ID to clear. If not provided, clears all conversations."
    ),
  },
  async ({ conversation_id }) => {
    if (conversation_id) {
      // Remove from memory
      conversations.delete(conversation_id);

      // Remove from disk
      const convDir = join(IMAGE_DIR, conversation_id);
      if (existsSync(convDir)) {
        rmSync(convDir, { recursive: true, force: true });
        return {
          content: [
            {
              type: "text",
              text: `Conversation ${conversation_id} cleared (removed from disk).`,
            },
          ],
        };
      } else {
        return {
          content: [
            {
              type: "text",
              text: `Conversation ${conversation_id} not found.`,
            },
          ],
        };
      }
    } else {
      // Clear all
      const count = conversations.size;
      conversations.clear();

      // Remove all conversation directories
      let diskCount = 0;
      try {
        const dirs = readdirSync(IMAGE_DIR, { withFileTypes: true });
        for (const dir of dirs) {
          if (dir.isDirectory()) {
            rmSync(join(IMAGE_DIR, dir.name), { recursive: true, force: true });
            diskCount++;
          }
        }
      } catch {}

      return {
        content: [
          {
            type: "text",
            text: `Cleared ${Math.max(count, diskCount)} conversation(s) from memory and disk.`,
          },
        ],
      };
    }
  }
);

// Start server
async function main() {
  // Load existing conversations from disk
  loadConversationsFromDisk();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("ImageGen MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
