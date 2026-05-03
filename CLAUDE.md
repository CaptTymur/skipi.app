# Skipi — Claude Code context

> Этот файл читается Claude Code автоматически при запуске в корне репозитория.
> Здесь — живой контекст проекта, куда мы идём, и договорённости по коду.

## Что это

Skipi — desktop-приложение для моряков: локальное хранилище сертификатов с отслеживанием сроков годности, генерацией CV, отправкой документов в крюинги и доступом к отзывам о судах. Tauri v2 (Rust backend + single-file HTML/JS frontend).

## P0 продуктовый фокус — Vessel Reviews

Главная growth-гипотеза: Skipi будет успешным, если им будут пользоваться много моряков. Крюинги начнут платить только после того, как в Skipi уже есть моряки, данные и поток кандидатов.

Дополнительная монетизация: ограниченные рекламные места / sponsored slots. Это должны быть релевантные морские предложения, явно помеченные как Sponsored: курсы, сертификаты, страховка, связь/SIM/eSIM, remittance, travel, экипировка, highlighted vacancies. Не вставлять рекламу в критические document/CV/package workflows и не маскировать рекламу под отзывы моряков.

Поэтому seafarer app должен быть ценен сам по себе. Не только документы/CV/dispatch, но и возможность узнать правду о судне перед контрактом.

P0 backlog: в разделе `Experience / Sea Service` встроить короткий survey судна:
- пользователь добавляет контракт с IMO;
- Skipi предлагает оценить судно “как на Booking”;
- оценки: overall, vessel condition, internet, living conditions/cabin, food, paperwork/workload, company attitude;
- review отправляется на сервер по IMO pseudonymously;
- другой моряк может искать отзывы по IMO/названию или видеть summary в vacancy detail;
- detailed reviews открываются после того, как пользователь сам отправил хотя бы один review.

В `skipi-server` уже есть задел: `GET /api/vessels/{imo}`, `GET /api/vessels/{imo}/reviews`, `POST /api/vessels/{imo}/reviews`, модели `Vessel`/`VesselReview`, pending moderation. В seafarer app пока нужен UI и локальный status/unlock.

Operational P0: до широкой публикации reviews нужен contingency plan на внезапный рост: app-config kill switches, local-only fallback, production Postgres, backups/restore, rate limits, metrics/alerts, moderation capacity, downloads mirror. Подробный Obsidian runbook: `Documents/Test/Skipi Handoff/06 — Contingency Plan — Exponential Growth.md`.

Infrastructure strategy: start on Contabo because cash matters, scale up within Contabo as a temporary buffer, but keep the system exit-ready from day one. No installers or critical files on VPS disk, production DB via `DATABASE_URL`, object storage external, backups off-provider, API behind `api.skipi.app`, migration drill required. Runbook: `Documents/Test/Skipi Handoff/08 — Infrastructure Migration Plan — Contabo First Exit Ready.md`.

- **Автор:** Tymur Rudov (Master Mariner)
- **Репозиторий:** https://github.com/CaptTymur/skipi.app (публичный)
- **Последний релиз:** v0.4.14 (drag-and-drop добавлен)
- **Auto-updater:** подписывает билды, клиенты тянут `latest.json` из GitHub Releases
- **Статус:** закрытая бета для приглашённых моряков

## Архитектура

```
skipi-public/
├── dist/index.html           ← весь frontend (~2600 строк, inline JS)
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   ├── db.rs              ← DocRecord + SQLite
│   │   └── commands/          ← Tauri #[command] функции
│   ├── tauri.conf.json        ← version + updater pubkey
│   └── Cargo.toml
└── .github/workflows/release.yml   ← CI триггерится на тег v*
```

Frontend — один `dist/index.html`, внутри весь JS inline. Нет сборки, нет node_modules. Правится напрямую.

## Ключевые договорённости

**Версионирование:** при релизе бампаем ВСЕ ТРИ места одновременно:
- `dist/index.html` → `var APP_VERSION='x.y.z'` (строка ~8) + span `welcome-version`
- `src-tauri/tauri.conf.json` → `"version"`
- `src-tauri/Cargo.toml` → `version =`

Потом `cd src-tauri && cargo update -p skipi && cd ..`, коммит, тег `vx.y.z`, push.

**CI:** собирает Linux + Windows. Репо публичный → Actions минуты unlimited на всех стандартных runners, кредиты покупать не нужно. macOS закомментирован в `release.yml` — не из-за денег, а потому что без Apple Developer $99 + нотаризации Gatekeeper показывает scream-warning на установке. Вернуть когда Apple Developer оформлен и настроен notarization pipeline.

**Подпись апдейтера:** ключ хранится в GitHub Secrets как `TAURI_SIGNING_PRIVATE_KEY`, пароль пустой (`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` удалён). Если придётся перегенерировать: `npx @tauri-apps/cli signer generate -w ~/.tauri/skipi_new.key`, новый `.pub` → `tauri.conf.json.plugins.updater.pubkey`.

**macOS Gatekeeper:** приложение не notarised (нет $99 Apple Developer). Пользователи видят «Apple не удалось подтвердить». Воркэраунд: `xattr -dr com.apple.quarantine /Applications/Skipi.app`. TODO: оформить Apple Developer когда дойдут руки.

**Email delivery decision:** единый кроссплатформенный fallback — генерировать `.eml` файл с subject/body/footer/attachments и открывать его/папку для пользователя. SMTP остаётся production path для прямой отправки из Skipi. Не делать `mailto:` с attachment как базовый путь: это не стандарт и ломается по-разному на Linux/Windows/macOS. Подробно: `EMAIL_DELIVERY_DECISION.md`; handoff для coding agent: `EMAIL_EML_IMPLEMENTATION_HANDOFF.md`.

**Стиль кода во frontend:**
- Var, не let/const (совместимость и привычка по файлу)
- Никаких фреймворков, всё ручной DOM через innerHTML
- Тосты: `showToast(msg, 'success' | 'error' | 'warn' | 'info')`
- Ошибки: `logError(ctx, e)` + обычный `showToast(''+e, 'error')`
- Вызов Rust: `await invoke('cmd_name', {arg1: ..., arg2: ...})`
- Диалог выбора файла: `await open({multiple:false, filters:[...]})`

## Статус документа vs категории

`DocRecord.template_id` — если не null, это **обязательный** документ из шаблона (passport, sid, seamans_book и т.д.). Если null — кастомный, пользователь сам добавил.

Классификация по цветам (см. `docStatusColor` в index.html, ~line 1340):
- **Красный** — expired ИЛИ (обязательный и нет файла)
- **Оранжевый** — < 30 дней
- **Тёмно-жёлтый** `#d4a017` — < 90 дней
- **Средне-жёлтый** `#eac94f` — < 180 дней
- **Светло-жёлтый** `#f7e38d` — < 365 дней
- **Зелёный** — > 1 года валидности
- **Серый** — нет срока годности

В дереве обязательные документы сортируются первыми и помечены ⭐ (`.req-mark`).

## Drag-and-drop (v0.4.14, свежее)

Реализовано через Tauri v2 события: `tauri://drag-drop`, `tauri://drag-over`, `tauri://drag-leave`. Для совместимости слушаю и старые имена `tauri://file-drop*`. Shared attach-path: `attachFFromPath(docId, sourcePath)` — используется и диалогом, и drop-ом. Auto-AI-scan триггерится после attach.

## Что ещё в бэклоге (NOT done)

Пользователь просил следующее (screenshots с красными пометками были), часть — для v0.4.15:

**Профиль моряка (Settings → Seafarer Profile и forced overlay):**
- Toggle «Готов принимать предложения / Не готов». Когда «Не готов» — дизейблить поля salary, nearest_airport, nearest_intl_airport, feedback/phone.
- Position — сделать жёсткий select вместо free text (использовать `RANKS` или `profileTax.positions`).
- Аэропорты — select с предзаполненным списком (сейчас `datalist` с hubs, нужно hard dropdown + поиск).
- Feedback: рядом с полем телефона — dropdown мессенджера (WhatsApp / Telegram / Viber / Signal / Other).
- Валюта min_salary уже есть (v0.4.13), но UX проверить.

**Work history entry (Sea Service → Add Entry):**
- `wh-vessel` — hard dropdown из ранее введённых судов + «ввести новое». Возможно хранить в отдельной vessels-таблице.
- `wh-flag` — select из флагов (Marshall Islands, Panama, Liberia, Malta, Bahamas, Cyprus, Singapore, Hong Kong, и т.д.).
- `wh-position` — уже select из RANKS ✓
- Загрузка документов per-entry уже есть (`attach_work_file`), но добавить возможность увидеть и переоткрыть уже привязанные файлы прямо из формы редактирования.

**Dispatch:**
- Подсветка текущего выбранного сертификата в списке (визуальный selected state).
- «Add custom certificate» — сделать кнопку видимой на главном doc view (а не только в скрытом месте).

**Разное:**
- Пользователь упомянул что «вчера я дал работу по обновлению, большое количество скриншотов. изменения из части из них были обработаны, но какие-то не обработаны» — стоит пройтись по git log за предыдущие релизы и сравнить с открытыми просьбами.

## Push-протокол

```bash
# после правок:
cd src-tauri && cargo update -p skipi && cd ..
git add -A
git commit -m "feat(v0.x.y): description"
git push origin main
git tag v0.x.y
git push origin v0.x.y
```

CI соберёт только Linux, ~10 минут. Auto-updater подтянет на уже установленных macOS-копиях.

## Команды для диагностики

```bash
# локальная сборка:
cd src-tauri && cargo tauri dev          # dev mode
cd src-tauri && cargo tauri build        # релизный бандл

# проверить подпись ключа:
cat ~/.tauri/skipi.key                    # должна быть 1 строка base64
cat ~/.tauri/skipi.key.pub                # короткий base64

# gh CLI для просмотра релизов:
gh release list --repo CaptTymur/skipi.app
gh run list --repo CaptTymur/skipi.app --limit 5

# очистка macOS quarantine после установки:
xattr -dr com.apple.quarantine /Applications/Skipi.app
```

## Tone для Claude Code

Пользователь — Master Mariner, говорит по-русски, пишет коротко и по делу. Предпочитает чтобы Claude:
- Сразу давал команды для копипасты (не спрашивал лишний раз)
- Не расписывал очевидное
- Коммитил версии единым commit message с префиксом `feat(vX.Y.Z):` или `fix(vX.Y.Z):`
- Не апдейтил `git config` и не делал force push без прямого запроса
