# チャット受け入れ確認表

`docs/chat-specification.md` 17章の受け入れ条件を、デプロイ前の自動テストと
デプロイ後の手動確認へ対応付ける。

|  # | 受け入れ条件                       | 自動テスト                                                                                                            | デプロイ後の確認                                    |
| -: | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
|  1 | OTPログインと初回表示名            | `chat/integration_test.ts`、`chat/auth_test.ts`、`chat/session_test.ts`                                               | OTP実配送、初回プロフィール遷移                     |
|  2 | 表示名変更を過去投稿へ反映         | `chat/integration_test.ts`、`chat/session_test.ts`                                                                    | 変更前の投稿者名を別アカウントで確認                |
|  3 | 複数ルーム作成                     | `chat/rooms_test.ts`                                                                                                  | ダッシュボードで複数ルームを確認                    |
|  4 | URLから参加申請                    | `chat/integration_test.ts`、`chat/join_requests_test.ts`                                                              | 未ログインの共有URLからログインして申請             |
|  5 | 承認前は閲覧・投稿不可             | `chat/integration_test.ts`、`chat/join_requests_test.ts`                                                              | 承認待ち画面とAPI拒否を確認                         |
|  6 | viewer/writerで承認                | `chat/integration_test.ts`、`chat/join_requests_test.ts`                                                              | オーナー画面で両権限を選択                          |
|  7 | 承認時刻以降だけ閲覧               | `chat/integration_test.ts`、`chat/messages_test.ts`                                                                   | 承認前後に投稿し、履歴を確認                        |
|  8 | 承認後の権限変更                   | `chat/integration_test.ts`、`chat/join_requests_test.ts`                                                              | 開いている画面で変更を即時確認                      |
|  9 | viewerの直接投稿を拒否             | `chat/integration_test.ts`、`chat/messages_test.ts`                                                                   | ブラウザ画面に投稿欄がないことも確認                |
| 10 | メッセージと申請のリアルタイム反映 | `chat/integration_test.ts`、`chat/events_test.ts`                                                                     | 複数ブラウザでSSE、再接続、50件超の履歴連続性を確認 |
| 11 | 申請の画面内・メール通知           | `chat/integration_test.ts`、`chat/join_requests_test.ts`、`chat/notifications_test.ts`                                | Resend管理画面と受信箱で実配送を確認                |
| 12 | 投稿者・オーナーによる削除         | `chat/messages_test.ts`                                                                                               | 削除表示を2権限で確認                               |
| 13 | 解除・拒否・ルーム・アカウント削除 | `chat/join_requests_test.ts`、`chat/rooms_test.ts`、`chat/session_test.ts`、`chat/integration_test.ts`                | 確認入力、再申請、削除後の画面を確認                |
| 14 | 利用上限とレート制限               | `chat/data_test.ts`、`chat/auth_test.ts`、`chat/rooms_test.ts`、`chat/join_requests_test.ts`、`chat/messages_test.ts` | 429の理由、再試行時刻、`Retry-After`を確認          |
| 15 | 既存タイマーが `/` で動作          | `server_test.ts`                                                                                                      | タイマー操作と文書の新規作成・保存・開くを確認      |

自動テストの一括実行:

```sh
deno task fmt:check
deno task check
deno task test
deno task lint
```

ブラウザ固有の遷移、Enter送信、Shift+Enter改行、スクロール位置、メール実配送は
外部環境に依存するため、`README.md` のデプロイ後スモークテストを必須とする。
