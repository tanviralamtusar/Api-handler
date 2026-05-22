const { GoogleGenAI } = require('@google/genai');

class VertexEngineService {
    constructor() {
        // Initialize Vertex with your Cloud project and location
        this.ai = new GoogleGenAI({
            vertexai: true,
            project: process.env.VERTEX_PROJECT_ID || 'project-83d1ec52-ca5c-420c-964',
            location: process.env.VERTEX_LOCATION || 'global' // Set to 'global' since you are using a 3.1 model!
        });

        const tools = [
            {
                googleSearch: {},
            },
        ];

        // Set up generation config
        this.generationConfig = {
            maxOutputTokens: 65535,
            temperature: 1,
            topP: 0.95,
            thinkingConfig: {
                thinkingLevel: "LOW",
            },
            safetySettings: [
                {
                    category: 'HARM_CATEGORY_HATE_SPEECH',
                    threshold: 'OFF',
                },
                {
                    category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
                    threshold: 'OFF',
                },
                {
                    category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
                    threshold: 'OFF',
                },
                {
                    category: 'HARM_CATEGORY_HARASSMENT',
                    threshold: 'OFF',
                }
            ],
            tools: tools,
        };
    }

    async processRequest({ message, history = [], systemPrompt = '', model = 'gemini-3.1-pro-preview', stream = false }) {
        let contents = [];

        // Map history to Google GenAI format
        for (const msg of history) {
            contents.push({
                role: msg.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: msg.content || '' }]
            });
        }

        const config = {
            ...this.generationConfig,
            systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined
        };

        // Create the chat session with history
        const chat = this.ai.chats.create({
            model: model,
            config: config,
            history: contents
        });

        if (stream) {
            return await chat.sendMessageStream({
                message: message
            });
        } else {
            const resp = await chat.sendMessage({
                message: message
            });
            return resp.text;
        }
    }
}

module.exports = new VertexEngineService();
