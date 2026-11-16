export type User = {
  id: number
  email: string
  display_name: string
}

// wrangler.jsonc の vars・束縛は worker-configuration.d.ts の Env。秘密(API キー)は `wrangler secret` で入る
// VAPID_PUBLIC_KEY は環境ごとに値が変わるので、wrangler types が出す文字の型(開発の値)でなく string にする
export type Bindings = Omit<Env, 'VAPID_PUBLIC_KEY'> & {
  VAPID_PUBLIC_KEY: string
  ANTHROPIC_API_KEY?: string
  GOOGLE_GENERATIVE_AI_API_KEY?: string
  // Web Push の VAPID(基盤 §7)。`wrangler secret` だけに置く
  VAPID_PRIVATE_KEY?: string
  VAPID_SUBJECT?: string
}

export type AppEnv = {
  Bindings: Bindings
  Variables: { user: User }
}
