// The one model provider Scopely ships for bounded assistance (P6, A49): Anthropic's Messages API
// through the official SDK, behind the ModelProvider seam in src/build/agents.ts. It is off unless
// the deployment sets SCOPELY_AI_PROVIDER=anthropic and SCOPELY_AI_API_KEY. The key is read from the
// environment at start-up, held in memory, never logged, stored in a row or sent to a browser.
//
// A low-cost model by default (founder decision, 2026-11-07): claude-haiku-5-5, at low effort.
import Anthropic from '@anthropic-ai/sdk';
import type { ModelProvider, ModelRequest, ModelResponse } from '../build/agents.js';

export const DEFAULT_ASSIST_MODEL = 'claude-haiku-5-5';

export class AnthropicModelProvider implements ModelProvider {
  readonly provider = 'anthropic';
  private readonly client: Anthropic;
  constructor(apiKey: string, readonly model: string = DEFAULT_ASSIST_MODEL, client?: Anthropic) {
    // maxRetries stays small: a person is waiting, and every retry is billed.
    this.client = client ?? new Anthropic({ apiKey, maxRetries: 1, timeout: 60_000 });
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const turns = req.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    const r = await this.client.messages.create({
      model: this.model,
      max_tokens: req.maxTokens ?? 4000,
      ...(system ? { system } : {}),
      messages: turns,
      output_config: { effort: 'low', ...(req.jsonSchema ? { format: { type: 'json_schema' as const, schema: req.jsonSchema } } : {}) },
    });
    if (r.stop_reason === 'refusal') throw new Error('model declined');
    if (r.stop_reason === 'max_tokens') throw new Error('model output cut off');
    const text = r.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    return {
      text,
      // Scopely records tokens; it never assumes a price, so the amount stays unknown.
      usage: { provider: this.provider, model: r.model, tokensIn: r.usage.input_tokens, tokensOut: r.usage.output_tokens, cost: { amount: null, currency: null } },
    };
  }
}

/** The assistance provider the deployment configured, or null: assistance is off. */
export function assistProviderFromEnv(env: NodeJS.ProcessEnv): ModelProvider | null {
  const which = (env.SCOPELY_AI_PROVIDER ?? '').trim();
  if (!which) return null;
  if (which !== 'anthropic') throw new Error(`SCOPELY_AI_PROVIDER=${which} is not a provider Scopely supports (anthropic)`);
  const key = (env.SCOPELY_AI_API_KEY ?? '').trim();
  if (!key) throw new Error('SCOPELY_AI_PROVIDER is set but SCOPELY_AI_API_KEY is not');
  return new AnthropicModelProvider(key, (env.SCOPELY_AI_MODEL ?? '').trim() || DEFAULT_ASSIST_MODEL);
}
