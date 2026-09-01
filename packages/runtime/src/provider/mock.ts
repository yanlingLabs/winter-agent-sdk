export interface Provider { generate(input: { prompt: string }): Promise<{ text: string }>; }
export const echoProvider: Provider = { async generate({ prompt }) { return { text: `echo: ${prompt}` }; } };
