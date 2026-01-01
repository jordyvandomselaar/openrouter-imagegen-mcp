#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";

// S3 Configuration (required)
interface S3Config {
  client: S3Client;
  bucket: string;
  publicUrlBase: string;
  prefix: string;
}

function initS3Config(): S3Config {
  const endpoint = process.env.S3_ENDPOINT;
  const bucket = process.env.S3_BUCKET;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  const publicUrlBase = process.env.S3_PUBLIC_URL_BASE;
  const region = process.env.S3_REGION || "auto";
  const prefix = process.env.S3_PREFIX || "images";

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey || !publicUrlBase) {
    throw new Error(
      "S3 configuration is required. Set these environment variables:\n" +
      "  S3_ENDPOINT - S3-compatible endpoint URL\n" +
      "  S3_BUCKET - Bucket name\n" +
      "  S3_ACCESS_KEY_ID - Access key\n" +
      "  S3_SECRET_ACCESS_KEY - Secret key\n" +
      "  S3_PUBLIC_URL_BASE - Public URL base for accessing images"
    );
  }

  const client = new S3Client({
    endpoint,
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
    forcePathStyle: true, // Required for most S3-compatible services like MinIO
  });

  console.error(`S3 configured: ${endpoint} / ${bucket} (prefix: ${prefix})`);
  console.error(`Public URL base: ${publicUrlBase}`);

  return {
    client,
    bucket,
    publicUrlBase: publicUrlBase.replace(/\/$/, ""), // Remove trailing slash
    prefix,
  };
}

const s3Config = initS3Config();

// Upload image to S3 and return public URL
async function uploadImageToS3(
  imageBuffer: Buffer,
  filename: string,
  mimeType: string,
  conversationId: string
): Promise<string> {
  const key = `${s3Config.prefix}/${conversationId}/${filename}`;

  await s3Config.client.send(
    new PutObjectCommand({
      Bucket: s3Config.bucket,
      Key: key,
      Body: imageBuffer,
      ContentType: mimeType,
    })
  );

  const publicUrl = `${s3Config.publicUrlBase}/${key}`;
  console.error(`Uploaded to S3: ${publicUrl}`);
  return publicUrl;
}

// Upload JSON data to S3
async function uploadJsonToS3(key: string, data: any): Promise<void> {
  await s3Config.client.send(
    new PutObjectCommand({
      Bucket: s3Config.bucket,
      Key: key,
      Body: JSON.stringify(data, null, 2),
      ContentType: "application/json",
    })
  );
}

// Download JSON data from S3
async function downloadJsonFromS3<T>(key: string): Promise<T | null> {
  try {
    const response = await s3Config.client.send(
      new GetObjectCommand({
        Bucket: s3Config.bucket,
        Key: key,
      })
    );
    const body = await response.Body?.transformToString();
    return body ? JSON.parse(body) : null;
  } catch (error: any) {
    if (error.name === "NoSuchKey") {
      return null;
    }
    throw error;
  }
}

// List objects under a prefix in S3
async function listS3Prefix(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await s3Config.client.send(
      new ListObjectsV2Command({
        Bucket: s3Config.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );

    for (const obj of response.Contents || []) {
      if (obj.Key) {
        keys.push(obj.Key);
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return keys;
}

// Delete all objects under a prefix in S3
async function deleteS3Prefix(prefix: string): Promise<number> {
  const keys = await listS3Prefix(prefix);
  if (keys.length === 0) return 0;

  // Delete in batches of 1000 (S3 limit)
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    await s3Config.client.send(
      new DeleteObjectsCommand({
        Bucket: s3Config.bucket,
        Delete: {
          Objects: batch.map(key => ({ Key: key })),
        },
      })
    );
  }

  return keys.length;
}

// Store conversation history for iterative image generation
interface ConversationMessage {
  role: "user" | "assistant";
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}

interface ConversationMetadata {
  id: string;
  firstPrompt: string;
  messageCount: number;
  imageCount: number;
}

const conversations = new Map<string, ConversationMessage[]>();

// Load existing conversations from S3 on startup
async function loadConversationsFromS3(): Promise<void> {
  try {
    const prefix = `${s3Config.prefix}/`;
    const keys = await listS3Prefix(prefix);

    // Find all messages.json files
    const messageKeys = keys.filter(k => k.endsWith("/messages.json"));

    for (const key of messageKeys) {
      // Extract conversation ID from key: {prefix}/{convId}/messages.json
      const parts = key.split("/");
      const convId = parts[parts.length - 2] || "";
      if (!convId) continue;

      const messages = await downloadJsonFromS3<ConversationMessage[]>(key);
      if (messages) {
        conversations.set(convId, messages);
        console.error(`Loaded conversation: ${convId}`);
      }
    }

    console.error(`Loaded ${conversations.size} conversations from S3`);
  } catch (err) {
    console.error(`Error loading conversations from S3: ${err}`);
  }
}

// Save conversation to S3
async function saveConversationToS3(convId: string, messages: ConversationMessage[]): Promise<void> {
  const key = `${s3Config.prefix}/${convId}/messages.json`;
  await uploadJsonToS3(key, messages);
}

// Get first user prompt from messages
function getFirstPrompt(messages: ConversationMessage[]): string {
  const firstUser = messages.find(m => m.role === "user");
  if (!firstUser) return "Unknown";
  return typeof firstUser.content === "string"
    ? firstUser.content.substring(0, 100)
    : "Image conversation";
}

// Convert stored messages to API format (fetch images from S3 URLs and convert to base64)
async function messagesToApiFormat(messages: ConversationMessage[]): Promise<Array<{ role: string; content: any }>> {
  const result: Array<{ role: string; content: any }> = [];

  for (const m of messages) {
    if (typeof m.content === "string") {
      result.push({ role: m.role, content: m.content });
      continue;
    }

    // Convert content array, fetching images from S3 URLs
    const apiContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

    for (const item of m.content) {
      if (item.type === "text" && item.text) {
        apiContent.push({ type: "text", text: item.text });
      } else if (item.type === "image_url" && item.image_url?.url) {
        // Fetch image from URL and convert to base64
        try {
          const response = await fetch(item.image_url.url);
          const buffer = await response.arrayBuffer();
          const base64 = Buffer.from(buffer).toString("base64");
          const contentType = response.headers.get("content-type") || "image/png";
          apiContent.push({
            type: "image_url",
            image_url: { url: `data:${contentType};base64,${base64}` }
          });
        } catch (err) {
          console.error(`Error fetching image from ${item.image_url.url}: ${err}`);
        }
      }
    }

    result.push({ role: m.role, content: apiContent.length > 0 ? apiContent : "" });
  }

  return result;
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

IMPORTANT: After this tool completes, you MUST call handle_generated_image with the returned IMAGE_URL, along with the conversation_id.

Do NOT use this tool to edit existing images - use edit_image instead.`,
  {
    prompt: z.string().describe("A full description of the image to generate. Be detailed about the scene, style, colors, composition, etc."),
    resolution: z.enum(["1K", "2K", "4K"]).optional().describe("Image resolution. Defaults to 1K. Only use 4K if the user explicitly requests high resolution."),
  },
  async ({ prompt, resolution }) => {
    const apiKey = getApiKey();
    const selectedModel = "google/gemini-3-pro-image-preview";

    // Create new conversation
    const convId = crypto.randomUUID();
    let messages: ConversationMessage[] = [];

    // Add user message
    messages.push({
      role: "user",
      content: prompt,
    });

    try {
      // Build request body
      const requestBody = {
        model: selectedModel,
        messages: await messagesToApiFormat(messages),
        modalities: ["image", "text"],
        image_config: {
          image_size: resolution || "1K",
        },
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

      const result: any = await response.json();

      const assistantMessage = result.choices[0]?.message;
      if (!assistantMessage) {
        throw new Error("No response from model");
      }

      // Build response content
      const responseContent: Array<{ type: "text"; text: string }> = [];

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
          let imageData: { buffer: Buffer; mimeType: string } | null = null;

          // Format 1: imageUrl.url (OpenRouter SDK style)
          if (image.imageUrl?.url) {
            imageData = await fetchImageAsBuffer(image.imageUrl.url);
          }
          // Format 2: image_url.url (OpenAI style)
          else if (image.image_url?.url) {
            imageData = await fetchImageAsBuffer(image.image_url.url);
          }
          // Format 3: direct url
          else if (image.url) {
            imageData = await fetchImageAsBuffer(image.url);
          }
          // Format 4: base64 data directly on object
          else if (image.data && typeof image.data === 'string') {
            const mimeType = image.mimeType || image.mime_type || 'image/png';
            imageData = { buffer: Buffer.from(image.data, 'base64'), mimeType };
          }
          // Format 5: b64_json (OpenAI DALL-E style)
          else if (image.b64_json) {
            imageData = { buffer: Buffer.from(image.b64_json, 'base64'), mimeType: 'image/png' };
          }

          if (imageData) {
            const extension = imageData.mimeType.split("/")[1] || "png";
            const filename = `${Date.now()}.${extension}`;

            // Upload directly to S3
            const s3Url = await uploadImageToS3(imageData.buffer, filename, imageData.mimeType, convId);
            console.error(`Uploaded image to S3: ${s3Url} (${(imageData.buffer.length / 1024).toFixed(1)}KB)`);

            responseContent.push({
              type: "text",
              text: `IMAGE_URL: ${s3Url}`,
            });

            // Store S3 URL in conversation history
            assistantContent.push({
              type: "image_url",
              image_url: { url: s3Url },
            });
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

      // Save conversation to memory and S3
      conversations.set(convId, messages);
      await saveConversationToS3(convId, messages);

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

// Helper to fetch image from URL and return as buffer
async function fetchImageAsBuffer(url: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
  try {
    if (url.startsWith("data:")) {
      const match = url.match(/^data:([^;]+);base64,(.+)$/);
      if (match && match[1] && match[2]) {
        return { buffer: Buffer.from(match[2], 'base64'), mimeType: match[1] };
      }
      return null;
    }
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());
    const mimeType = response.headers.get("content-type") || "image/png";
    return { buffer, mimeType };
  } catch (error) {
    console.error(`Failed to fetch image from ${url}: ${error}`);
    return null;
  }
}

// Tool: Edit image (iterate on existing images)
server.tool(
  "edit_image",
  `Request a new version of an image with changes. The model receives the previous image as context.

IMPORTANT: After this tool completes, you MUST call handle_generated_image with the returned IMAGE_URL, along with the conversation_id.

NOTE: The model generates a new image inspired by your description and the previous image. Results may vary - some edits work well, others may produce a different image. For best results, be specific about what to keep and what to change.

Good prompts:
- "Make the sky orange but keep the cat exactly the same"
- "Add a small rainbow in the top right corner"
- "Change only the cat's color to red, keep everything else identical"`,
  {
    conversation_id: z.string().describe("The conversation ID from a previous generate_image or edit_image call"),
    prompt: z.string().describe("Describe what to CHANGE about the image. E.g., 'make the background blue', 'add a rainbow', 'remove the person on the left'"),
    resolution: z.enum(["1K", "2K", "4K"]).optional().describe("Image resolution. Defaults to 1K. Only use 4K if the user explicitly requests high resolution."),
  },
  async ({ conversation_id, prompt, resolution }) => {
    const apiKey = getApiKey();
    const selectedModel = "google/gemini-3-pro-image-preview";

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

    // Find the most recent image URL from conversation history
    let lastImageUrl: string | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!;
      if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item.type === "image_url" && item.image_url?.url) {
            lastImageUrl = item.image_url.url;
            break;
          }
        }
        if (lastImageUrl) break;
      }
    }

    // Build the edit request with image inline in the user message
    const editContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

    // Add the previous image inline (fetch from S3 and convert to base64)
    if (lastImageUrl) {
      const imageData = await fetchImageAsBuffer(lastImageUrl);
      if (imageData) {
        const base64 = imageData.buffer.toString("base64");
        editContent.push({
          type: "image_url",
          image_url: { url: `data:${imageData.mimeType};base64,${base64}` }
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
      const requestBody = {
        model: selectedModel,
        messages: [
          {
            role: "user",
            content: editContent,
          }
        ],
        modalities: ["image", "text"],
        image_config: {
          image_size: resolution || "1K",
        },
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

      const result: any = await response.json();

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
        const assistantContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

        if (textContent) {
          assistantContent.push({ type: "text", text: textContent });
        }

        for (const image of images) {
          // Try multiple formats: OpenRouter, OpenAI, Gemini, etc.
          let imageData: { buffer: Buffer; mimeType: string } | null = null;

          if (image.imageUrl?.url) {
            imageData = await fetchImageAsBuffer(image.imageUrl.url);
          } else if (image.image_url?.url) {
            imageData = await fetchImageAsBuffer(image.image_url.url);
          } else if (image.url) {
            imageData = await fetchImageAsBuffer(image.url);
          } else if (image.data && typeof image.data === 'string') {
            const mimeType = image.mimeType || image.mime_type || 'image/png';
            imageData = { buffer: Buffer.from(image.data, 'base64'), mimeType };
          } else if (image.b64_json) {
            imageData = { buffer: Buffer.from(image.b64_json, 'base64'), mimeType: 'image/png' };
          }

          if (imageData) {
            const extension = imageData.mimeType.split("/")[1] || "png";
            const filename = `${Date.now()}.${extension}`;

            // Upload directly to S3
            const s3Url = await uploadImageToS3(imageData.buffer, filename, imageData.mimeType, convId);
            console.error(`Uploaded edited image to S3: ${s3Url} (${(imageData.buffer.length / 1024).toFixed(1)}KB)`);

            responseContent.push({
              type: "text",
              text: `IMAGE_URL: ${s3Url}`,
            });

            // Store S3 URL in conversation history
            assistantContent.push({
              type: "image_url",
              image_url: { url: s3Url },
            });
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

      // Save conversation to memory and S3
      conversations.set(convId, messages);
      await saveConversationToS3(convId, messages);

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
1. Share the image URL with the user
2. Ask the user if they would like to make any changes to the image
3. If the user wants changes, use edit_image with the conversation_id to iterate`,
  {
    image_url: z.string().describe("The S3 image URL returned by generate_image or edit_image"),
    conversation_id: z.string().describe("The conversation ID for this image generation session"),
  },
  async ({ image_url, conversation_id }) => {
    return {
      content: [
        {
          type: "text",
          text: `Image available at: ${image_url}\n\nConversation ID: ${conversation_id}\n\nShare this URL with the user. Ask if they'd like to make any changes to the image. If yes, use edit_image with this conversation_id to iterate.`,
        },
      ],
    };
  }
);

// Tool: List conversations
server.tool(
  "list_conversations",
  "List all image generation conversations (persisted to S3). Returns conversation IDs and descriptions.",
  {},
  async () => {
    const convList: string[] = [];

    try {
      // Get all conversation IDs from in-memory cache (loaded from S3 on startup)
      for (const [convId, messages] of conversations.entries()) {
        const description = getFirstPrompt(messages).substring(0, 50);
        const messageCount = messages.length;

        // Count images in conversation
        let imageCount = 0;
        for (const msg of messages) {
          if (Array.isArray(msg.content)) {
            for (const item of msg.content) {
              if (item.type === "image_url" && item.image_url?.url) {
                imageCount++;
              }
            }
          }
        }

        convList.push(`- **${convId}**\n  "${description}${description.length >= 50 ? '...' : ''}" (${messageCount} messages, ${imageCount} images)`);
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
  "Clear a specific conversation or all conversations (removes from S3).",
  {
    conversation_id: z.string().optional().describe(
      "The conversation ID to clear. If not provided, clears all conversations."
    ),
  },
  async ({ conversation_id }) => {
    if (conversation_id) {
      // Remove from memory
      const existed = conversations.has(conversation_id);
      conversations.delete(conversation_id);

      // Remove from S3
      const prefix = `${s3Config.prefix}/${conversation_id}/`;
      const deletedCount = await deleteS3Prefix(prefix);

      if (existed || deletedCount > 0) {
        return {
          content: [
            {
              type: "text",
              text: `Conversation ${conversation_id} cleared (removed ${deletedCount} objects from S3).`,
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

      // Remove all from S3
      const prefix = `${s3Config.prefix}/`;
      const deletedCount = await deleteS3Prefix(prefix);

      return {
        content: [
          {
            type: "text",
            text: `Cleared ${count} conversation(s) from memory (${deletedCount} objects from S3).`,
          },
        ],
      };
    }
  }
);

// Start server
async function main() {
  // Load existing conversations from S3
  await loadConversationsFromS3();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("ImageGen MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
