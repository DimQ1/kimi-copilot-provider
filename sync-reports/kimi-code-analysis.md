# Журнал анализа изменений kimi-code → kimi-copilot-provider

Новейшие записи сверху. Каждый анализ начинается от `<to-sha>` предыдущего.
Подробности процесса — в агенте `.github/agents/sync-kimi-code.agent.md`.

## Анализ от 2026-07-30

- **Диапазон коммитов:** `f8ec3d1656326eecc2bc2fb6a1163d351bb596cc` .. `d8f455d6942280cce2c8a93795515494d4b9e231` (14 коммитов)
- **Дата предыдущего анализа:** 2026-07-29
- **Репозиторий kimi-code:** найден как второй корень multi-root workspace (`e:\Learning\kimi-code`, структура верифицирована: `pnpm-workspace.yaml`, `packages/kosong`, корневой `AGENTS.md`), HEAD `d8f455d6942280cce2c8a93795515494d4b9e231` от 2026-07-30
- **Свежесть:** fetch выполнен; HEAD == upstream (origin/main): да; локальных незакоммиченных изменений нет

### ✅ Полезные изменения
—

### 💡 Полезные промпты / инструкции
| Файл | Что содержит | Почему полезно |
|---|---|---|
| `packages/kosong/src/errors.ts` + `packages/agent-core-v2/src/kosong/contract/errors.ts` (коммит `dbb69a267`, откачен `1896d1a13`) | Классификатор `isImageFormatError`: production-фраза Kimi «Unsupported image. Please try another one.» не матчилась паттерном `unsupported image (?:url\|format\|type)`; добавлен standalone-паттерн `/unsupported image(?=\s*(?:[.!?]\|$))/` с lookahead-границей, чтобы «unsupported image size/count» НЕ классифицировались как формат | Провайдер имеет деградацию медиа (`onRequestTooLarge` → `stripImagesToMarkers`), но НЕ распознаёт 400 «Unsupported image.» как детерминированное отклонение изображения: такой запрос падает фатально. Паттерн (с откатом — значит, в kimi-code ещё спорят о форме, но сам production-кейс подтверждён) стоит учесть при реализации image-format fallback в `src/error-handlers.ts` / `src/api-client.ts`. Формулировку и границу lookahead можно взять как есть |

### ❌ Нерелевантные изменения
| Коммит | Изменение | Почему не применимо |
|---|---|---|
| `dbb69a267` + `1896d1a13` | fix(kosong) «Unsupported image.» + его revert | Взаимно гасятся в диапазоне; net-изменения в kosong нет. Учтено выше как идея для промптов/классификатора, а не как код к переносу |
| `d8f455d69`, `37d9bdc58`-стиль | docs(changelog): синк changelog 0.31.0 (#2404) | Релизная рутина kimi-code |
| `479403e70`, `0f3b106c4`, `6d0a04648` | apps/vscode: релиз 0.6.6, переформулировка sign-in, доступность sign-in с no-models экрана | Официальное VS Code расширение Kimi — отдельный продукт, не наш провайдер |
| `ea81c9a3c` | kap-server: `GET /oauth/userinfo` с профилем managed-аккаунта (#2363) | Серверный OAuth-путь; провайдер ходит напрямую в api.kimi.com по sk-ключу |
| `bc28e9d80` | ci: релиз пакетов 0.31.0 (#2342) | CI-инфраструктура |
| `d36f4c58f` | agent-core-v2: удаление experimental fault-injection домена (#2399) | Внутренний тестовый механизм движка; у провайдера нет requester-цикла движка |
| `d10b1c130` | agent-core-v2: cold-miss для кэш-записей read-model без обязательных полей (#2395) | Кэш метаданных сессий сервера; вне контракта chat API |
| `40172c7ca` | Унификация host identity (`X-Msh-Platform`, `productName`) в OAuth/telemetry/kap-server (#2382) | Заголовки managed-OAuth транспорта; провайдер не использует OAuth device flow. Потенциально интересно, только если захотим идентифицировать провайдер в API через свои X-Msh-* заголовки — решение за пользователем, сейчас не требуется |
| `691ec4679` | TaskOutput tool: убраны блокирующие block/timeout параметры (v1+v2) (#2379) | Tool-семантика движка агента; в Copilot Chat tool-цикл ведёт VS Code, провайдер лишь транслирует tool definitions |
| `fa2c5ce18` | Plugin-contributed custom agents (#2365) | Плагинная система CLI, не API |
| `02d77b20d` | Плагины: `systemPrompt`/`systemPromptPath` в manifest (#2314) | Формирование системного промпта CLI; провайдер передаёт сообщения Copilot как есть |

### ❓ Требует решения пользователя
| Коммит | Изменение | Вопрос |
|---|---|---|
| `dbb69a267` (reverted `1896d1a13`) | Production-фраза Kimi «Unsupported image. Please try another one.» (400) подтверждена как детерминированное отклонение формата изображения | Реализовать ли в провайдере классификатор image-format ошибок (400 с `unsupported image` в теле) с автоматическим fallback — пересылка через `stripImagesToMarkers` по аналогии с onRequestTooLarge? Или ограничиться понятным сообщением пользователю «изображение не поддерживается, удалите вложение»? |

### 📋 План внедрения
1. (по решению выше) `src/api-client.ts` → добавить `isImageFormatError(err)` (400 + `unsupported image`/`does not represent a valid image`/`could not process image` в теле, с lookahead-границей как в kosong) → при совпадении вызывать деградацию `onRequestTooLarge`-подобным хуком или вернуть дружественное сообщение → риск: ложные срабатывания на иных 400 → проверить unit-тестами в `src/test/provider.test.ts` с мок-телами Kimi.
2. — (остальные изменения диапазона не требуют внедрения: `packages/kosong` net-код не изменился, контракт chat-completions, SSE, токены и модели не затронуты)

**Следующий анализ начинать с:** `d8f455d6942280cce2c8a93795515494d4b9e231`

## Анализ от 2026-07-29

- **Диапазон коммитов:** `cdbd33c13c7f5cd4c49ec112ee4313b3938a7752` .. `f8ec3d1656326eecc2bc2fb6a1163d351bb596cc` (13 коммитов)
- **Дата предыдущего анализа:** 2026-07-28
- **Репозиторий kimi-code:** найден как соседняя папка `../kimi-code` относительно корня провайдера (`E:\Learning\kimi-code`, структура верифицирована: `pnpm-workspace.yaml`, `packages/kosong`, корневой `AGENTS.md`), HEAD `f8ec3d1656326eecc2bc2fb6a1163d351bb596cc` от 2026-07-29
- **Свежесть:** fetch выполнен; HEAD == upstream (origin/main): да; локальных незакоммиченных изменений нет

### ✅ Полезные изменения
—

### 💡 Полезные промпты / инструкции
| Файл | Что содержит | Почему полезно |
|---|---|---|
| `AGENTS.md` (коммит `ceaa96942`) | Дополнена карта проекта: `apps/kimi-inspect` (веб-инспектор debug-поверхности kap-server), `packages/kap-server` (контракт op-batch sequencing для transcript), `packages/minidb` (встроенное хранилище с полнотекстовым поиском) | Носит чисто навигационный характер для монорепо kimi-code; для провайдера ценности нет — он не работает с kap-server. Пригодится только если решим строить похожий debug-инструментарий |

### ❌ Нерелевантные изменения
| Коммит | Изменение | Почему не применимо |
|---|---|---|
| `f8ec3d165` | docs: правка мёртвых якорных ссылок в en/zh документации (#2348) | Внутренняя документация kimi-code |
| `b850c5f8f` | fix(node-sdk): проброс applyPersistedSecondaryModel в agent-core-v2 (#2345) | Архитектура node-sdk/secondary model, вне контракта Kimi API |
| `37d9bdc58` | docs(changelog): синхронизация changelog 0.30.0 (#2343) | Релизная рутина |
| `efac96c8a` | feat(agent-core): кастомные agent-файлы и secondary model на v1-движке (#2232) | Возможности движка агента, не API моделей |
| `16c7189bd` | ci: релиз пакетов (#2244) | CI-инфраструктура |
| `973e2a008` | chore: очистка changeset'ов перед релизом (#2335) | Релизная рутина |
| `67dd03149` | feat(tui): настраиваемая статусная строка футера (#2255) | TUI kimi-code, к VS Code расширению не относится |
| `ceaa96942` | feat(kap-server): глобальный поиск сообщений (literal и live-session режимы) (#2321) | Серверный поиск по сессиям; провайдер работает только с chat-completions API |
| `f79fde2b9` | feat(node-sdk): миграция поверхности SDK на agent-core-v2 (#2262) | Внутренняя архитектура SDK |
| `d88b3775c` | fix(agent-core-v2): учёт отклонённых валидацией tool-вызовов в repeat breaker (#2317) | Логика движка агента (защита от зацикливания tool calls); в VS Code tool-цикл ведёт Copilot Chat, а не провайдер |
| `de0ba9d06` | fix(agent-core): то же исправление для v1-движка (#2313) | Аналогично — внутренняя логика движка |
| `d03a4886f` | feat(server): снятие лимита 50 MiB на загрузку файлов, стриминг на диск (#2312) | Файловые аплоады kap-server, не chat API; на наш 2 MiB request-body лимит не влияет |
| `b0f43aea2` | feat(oauth): структурированные строки managed-usage (#2300) | OAuth/биллинг kimi-code CLI; провайдер аутентифицируется напрямую через `sk-kimi-` ключ |

### ❓ Требует решения пользователя
—

### 📋 План внедрения
1. — (изменений для внедрения нет: в диапазоне не затронут `packages/kosong`, контракт chat-completions API, SSE-стриминг, подсчёт токенов и модели не менялись)

**Следующий анализ начинать с:** `f8ec3d1656326eecc2bc2fb6a1163d351bb596cc`
## Анализ от 2026-07-28

- **Диапазон коммитов:** `a9af42e6987044e0ec8d21cfe693dfe96e21f1a4` .. `cdbd33c13c7f5cd4c49ec112ee4313b3938a7752` (6 коммитов)
- **Дата предыдущего анализа:** нет (первый запуск; точка отсчёта — блок «Точка отсчёта (инициализация)» ниже)
- **Репозиторий kimi-code:** найден как второй корень multi-root workspace (`e:\Learning\kimi-code`, структура верифицирована: `pnpm-workspace.yaml`, `packages/kosong`, корневой `AGENTS.md`), HEAD `cdbd33c13c7f5cd4c49ec112ee4313b3938a7752` от 2026-07-28
- **Свежесть:** fetch выполнен; HEAD == upstream (origin/main): да; локальных незакоммиченных изменений нет

### ✅ Полезные изменения
| Коммит | Изменение | Почему полезно | Приоритет |
|---|---|---|---|
| `cdbd33c13c7f5cd4c49ec112ee4313b3938a7752` | kosong: 429 с исчерпанной квотой (Moonshot `exceeded_current_quota_error`, OpenAI `insufficient_quota`, billing-паттерны в тексте) выделен в отдельный `APIProviderQuotaExhaustedError`: fail fast вместо 10 ретраев (~3 мин «зависания»), исключён из retry/rate-limit логики, в телеметрии — `quota_exhausted`. Распознавание вынесено в vendor-hook `convertError` (Kimi — `classifyKimiQuotaError`, включая путь Anthropic-транспорта и in-stream SSE error events без HTTP-статуса) | Провайдер напрямую проксирует Kimi API: при исчерпании квоты/баланса пользователь сейчас может получать неразличимую от rate-limit ошибку. Стоит различать quota-429 и transient-429 в `src/error-handlers.ts` / `src/api-client.ts` (по `error.type` / `error.code` / billing-формулировкам в теле ответа, включая SSE error-кадры) и показывать пользователю понятное сообщение «квота исчерпана, пополните баланс» вместо generic-ошибки | high |

### 💡 Полезные промпты / инструкции
| Файл | Что содержит | Почему полезно |
|---|---|---|
| `.agents/skills/gen-changesets/SKILL.md` (kimi-code) | Дисциплина версионирования: bump-уровни, обязательный ченджлог, запрет major без подтверждения пользователя | Созвучно правилу провайдера «всегда бампать patch в `package.json` перед сборкой .vsix и вести CHANGELOG.md»; можно позаимствовать явный чек-лист перед релизом |
| `AGENTS.md` (kimi-code, раздел General Coding Rules) | «Не чинить реализацию под старый тест, если тест упал из-за правки пользователя — сначала чинить тест»; «не плодить новые тестовые файлы, добавлять в существующие» | Прямо применимо к `src/test/` провайдера (provider.test.ts, context-tracker.test.ts и др.) |

### ❌ Нерелевантные изменения
| Коммит | Изменение | Почему не применимо |
|---|---|---|
| `e55608845` | packages/tree-sitter-bash: чисто-TS парсер bash + сервис bashParser в agent-core-v2 | Внутренний инструмент CLI (permission matching для Bash tool); провайдер не исполняет шелл-команды |
| `7e30add44` | kap-server: глобальный endpoint `fs:mkdir` | Провайдер не ходит в kap-server API, работает напрямую с `api.kimi.com` |
| `77618e38c` | kap-server: облачная телеметрия engine-событий | Серверная инфраструктура CLI; у провайдера своя локальная статистика usage в `globalState` |
| `a77ee0382` | agent-core-v2: домен hostIdentity (productName / replyStyleGuide в системном промпте) | Касается системного промпта CLI-агента; провайдер передаёт сообщения Copilot Chat как есть, системный промпт не формирует |
| `3b017821c` | kap-server: `secondary_model` в config API | Конфиг CLI-сервера; у провайдера своя per-model конфигурация через `kimiCopilot.modelConfigs` |

### ❓ Требует решения пользователя
| Коммит | Изменение | Вопрос |
|---|---|---|
| `cdbd33c13c7f5cd4c49ec112ee4313b3938a7752` | Классификация quota-429 по vendor-hook: сигнатуры Kimi (`exceeded_current_quota_error`, billing-формулировки) | ✅ **РЕШЕНО 2026-07-28:** пользователь одобрил внедрение — реализовано в v1.9.2 (см. статус в плане ниже). |

### 📋 План внедрения
1. `src/error-handlers.ts` → добавить классификатор `isQuotaExhaustedError`: поиск `exceeded_current_quota_error` / `insufficient_quota` в `error.type`/`error.code` тела ответа + fallback на billing-паттерны в тексте сообщения → риск: ложные срабатывания на нестандартных gateway → проверить unit-тестами в `src/test/provider.test.ts` с мок-телами Kimi/OpenAI.
2. `src/api-client.ts` → при quota-429 показывать отдельное сообщение («квота/баланс исчерпаны», ссылка на консоль Kimi) и НЕ ретраить/не глотать как transient rate limit; учесть SSE error-кадры без HTTP-статуса → риск: формат SSE-ошибок Kimi API может отличаться → проверить вручную на исчерпанном/тестовом ключе или мок-стримом.
3. `CHANGELOG.md` + бамп patch-версии `package.json` при внедрении → по AGENTS.md провайдера.

**Статус внедрения (2026-07-28):** ✅ выполнено в v1.9.2 — шаги 1–3 реализованы (`isQuotaExhaustedError` + `QuotaExhaustedHandler` в `error-handlers.ts`, fail-fast в `api-client.ts`, 7 новых тестов, 99 passing, CHANGELOG + версия 1.9.2).

**Следующий анализ начинать с:** `cdbd33c13c7f5cd4c49ec112ee4313b3938a7752`

---

## Точка отсчёта (инициализация)

- **Дата инициализации:** 2026-07-28
- **HEAD kimi-code на момент инициализации:** `a9af42e6987044e0ec8d21cfe693dfe96e21f1a4` (2026-07-27, `docs(changelog): sync 0.29.2`)
- Следующий анализ должен начинаться с этого sha: `git log a9af42e..HEAD -- packages/kosong packages/agent-core packages/kap-server`.
- История до этой точки не анализировалась. Если нужен ретроспективный анализ — запустить отдельно с явным диапазоном.