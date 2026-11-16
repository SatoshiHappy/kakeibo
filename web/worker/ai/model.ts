// AI のベンダーとモデルを環境の設定で選ぶ(基盤 §4)。AI を呼ぶ処理はこのファイルと reader.ts だけに置く。
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { LanguageModel } from 'ai'

export type AiEnv = {
  AI_VENDOR: string
  AI_MODEL: string
  ANTHROPIC_API_KEY?: string
  GOOGLE_GENERATIVE_AI_API_KEY?: string
}

export class AiNotConfigured extends Error {
  constructor(what: string) {
    super(`AI is not configured: ${what}`)
    this.name = 'AiNotConfigured'
  }
}

export function languageModel(env: AiEnv): LanguageModel {
  switch (env.AI_VENDOR) {
    case 'anthropic':
      if (!env.ANTHROPIC_API_KEY) throw new AiNotConfigured('ANTHROPIC_API_KEY')
      return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })(env.AI_MODEL)
    case 'google':
      if (!env.GOOGLE_GENERATIVE_AI_API_KEY) throw new AiNotConfigured('GOOGLE_GENERATIVE_AI_API_KEY')
      return createGoogleGenerativeAI({ apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY })(env.AI_MODEL)
    default:
      throw new AiNotConfigured(`AI_VENDOR=${env.AI_VENDOR}`)
  }
}

/** 呼ぶ側はこの入れ物を通す(テストで差し替えるため。設定で切り替える口ではない)。 */
export const models = { languageModel }
