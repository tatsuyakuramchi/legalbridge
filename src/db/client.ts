/**
 * db/client.ts
 * Prismaクライアントのシングルトン
 *
 * DATABASE_URL 環境変数の値に応じて接続先が自動的に切り替わる:
 *   ローカル: postgresql://postgres:password@localhost:5432/legalbridge
 *   RDS本番:  postgresql://user:pass@xxx.rds.amazonaws.com:5432/legalbridge
 *
 * コードの変更は一切不要。.env の DATABASE_URL を書き換えるだけ。
 */

import { Prisma, PrismaClient } from "@prisma/client";

// 開発時のログ出力（本番では無効化）
const logLevel: Prisma.LogLevel[] = process.env.NODE_ENV === "production"
  ? []
  : ["query", "warn", "error"];

// グローバルシングルトン（開発時のホットリロードで多重接続しないために必要）
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma = global.__prisma ?? new PrismaClient({ log: logLevel });

if (process.env.NODE_ENV !== "production") {
  global.__prisma = prisma;
}

export default prisma;
