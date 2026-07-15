# Skipi mobile — Maestro smoke tests

Smoke-флоу для мобильных приложений Skipi (Tauri + WebView). Тесты **не меняют код приложения** —
это отдельная папка `.maestro/` с YAML-флоу.

## Приложения и appId

| Приложение | Репозиторий | appId (Maestro) | Статус |
|---|---|---|---|
| Skipi Seafarer | `skipi-mobile-start` | `app.skipi.seafarer` | активен |
| Skipi Crewing | `skipi-crewing` | `app.skipi.crewing.mobile` | активен |
| Skipi Broker | `skipi-broker` | `app.skipi.broker` | later (stub готов) |

## Флоу (в каждом репозитории)

- `smoke.yaml` — пуск → первый экран → демо → настройки → back → горизонтальный overflow (best-effort).
- `connect_qr.yaml` — экран токена/подключения открывается; экран QR **только оболочка и не имитирует успех**.
  (У Broker оба объединены в `smoke.yaml`.)

Покрытие шагов ТЗ: 1 launch, 2 first screen, 3 demo, 4 settings, 5 back/home,
6 overflow (эвристика — Maestro не меряет пиксели), 7 token/connect, 8 QR shell-only (assertNotVisible на «успех»).

## Установка Maestro

```bash
curl -Ls "https://get.maestro.mobile.dev" | bash
# перезапусти шелл или: export PATH="$PATH:$HOME/.maestro/bin"
maestro --version
```

## Android — эмулятор или реальное устройство

```bash
# реальное устройство: включи USB-debugging, подключи кабелем
adb devices            # устройство/эмулятор должно быть в списке
# эмулятор:
emulator -list-avds
emulator -avd <AVD_NAME> &
```

## Собрать и установить приложение (Tauri Android, debug)

Из корня репозитория приложения:

```bash
npm run tauri android build -- --apk --debug      # или: cargo tauri android build --apk --debug
# поставить собранный APK:
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

Проверить, что пакет установлен: `adb shell pm list packages | grep skipi`.

## Запуск тестов

```bash
cd /home/linux/Developer/skipi-mobile-start     # или skipi-crewing
maestro test .maestro/                          # все флоу
maestro test .maestro/smoke.yaml                # один флоу
maestro test --include-tags smoke .maestro/     # по тегу
```

## Артефакты (скриншоты / видео)

- Скриншоты из `takeScreenshot` сохраняются в каталог прогона `~/.maestro/tests/<timestamp>/`.
- Принудительно собрать артефакты в папку: `maestro test --debug-output ./maestro-artifacts .maestro/`
- Видео записи: `maestro record .maestro/smoke.yaml maestro-artifacts/seafarer-smoke.mp4`

## Калибровка селекторов (важно для первого прогона)

Флоу написаны «вслепую» по строкам из `dist/index.html` — навигация к Настройкам/Connect/QR внутри
приложения помечена комментариями `CALIBRATE` и `optional: true`, чтобы smoke не падал ложно до калибровки.
Открой живое дерево доступности и поправь селекторы:

```bash
maestro studio        # инспектор UI: смотри реальные тексты/элементы, копируй точные селекторы
```

После калибровки убери `optional: true` у шагов 4/7/8, чтобы smoke честно падал при регрессе.

Замечание про WebView: Maestro видит текст WebView через accessibility-дерево (в Android включено по умолчанию).
Если текст не находится — проверь в `maestro studio`; при необходимости таргетируй по координатам/`index`.

## iOS (только на Mac)

Те же флоу работают на iOS Simulator (appId = bundle id, напр. `app.skipi.seafarer`).
Нужно установить приложение на запущенный симулятор, затем `maestro test .maestro/`.

## CI / контрольные прогоны

Для прогонов на матрице устройств (Android low-end/modern, iPhone, iPad) — см. отдельный
handoff по BrowserStack (App Automate принимает Maestro-флоу).

## ⚠️ Находка (2026-06-25, живой прогон на Pixel6/android-34)
Tauri/wry WebView **НЕ отдаёт DOM в Android accessibility-дерево** → Maestro **не видит и не тапает текст внутри приложения** (проверено: `maestro hierarchy` = 1 узел WebView, 0 текста). Поэтому:
- текстовые флоу (`smoke.yaml`, `connect_qr.yaml`) — **целевые**: заработают после включения WebView-a11y в приложении (изменение app/Android-проекта) ИЛИ через Maestro AI-ассерты (`assertWithAi`/`extractTextWithAi`, нужен ключ);
- для артефактов **сейчас** — `screenshots.yaml`: launch + скриншоты + тапы по координатам (%), без текстовых селекторов:
  `maestro test .maestro/screenshots.yaml` (скриншоты `NN-*.png` создаются в рабочей папке).
- Доп. находка: текущий Android **debug-APK Seafarer устарел** — свежая установка сразу открывает 9-шаговый мастер «Создание профиля» (Issue A) и тёмную тему; фиксы welcome-экрана и light-default (есть на iOS-ветке) в этот APK ещё не попали.
