# Open & test Evabob in Android Studio

**Do not run the laptop/Windows desktop target.** Use an **Android emulator** started from Android Studio’s Device Manager.

## One-click open

```powershell
cd C:\Users\victoren\Desktop\Projects\evabob\mobile
.\open_in_android_studio.ps1
```

**Important:** Open the **`mobile`** folder (the Flutter project),  
not `mobile/android` and not the parent `Evabob` folder.

## Run from Android Studio (only)

1. Wait for **Gradle sync** / Flutter plugin indexing to finish  
2. **Device Manager** (phone icon) → create/start a **Pixel** emulator (API 34+ preferred)  
3. Top toolbar **device dropdown** → pick that **Android emulator**  
   - **Do not** pick **Windows (desktop)**  
   - **Do not** pick Chrome unless you want web preview  
4. Run config: **Evabob Android** (or **main.dart**) → green **Run ▶**  
   - Entry: `lib/main.dart`  
   - Args already include: `--dart-define-from-file=dart_defines.json`  
     (Dynamic env id, contracts, Pusher, `AUTO_DEMO=false`)

5. Keep the API running on the host for real data:

```powershell
cd C:\Users\victoren\Desktop\Projects\evabob\server
npm run dev
```

Emulator reaches the host API at `http://10.0.2.2:8787` automatically.

## What you should see

- **Login** screen (email OTP via Dynamic) because `AUTO_DEMO=false`  
- Or tap **Skip — demo account** for offline UI without Dynamic OTP  
- After sign-in: Home · Chat · Send · Activity · Account · Agent stack  

## First-time Android Studio setup

1. **Plugins** → install **Flutter** and **Dart** → Restart IDE  
2. **File → Settings → Languages & Frameworks → Flutter**  
   - Flutter SDK path: `C:\Users\victoren\develop\flutter`  
3. **Device Manager** → Create Device → Pixel → system image **API 34+** → Finish  

## Real Dynamic auth values

Configured in `dart_defines.json` (used by the **Evabob Android** run config):

- `DYNAMIC_ENVIRONMENT_ID=6b48d938-66fa-4259-bacc-1142403886f6`  
- `AUTO_DEMO=false`  

API token stays on **server only** (`server/.env` → `DYNAMIC_API_TOKEN`).

## If Gradle / Flutter fails

```powershell
$env:PATH = "C:\Users\victoren\develop\flutter\bin;$env:PATH"
cd C:\Users\victoren\Desktop\Projects\evabob\mobile
flutter clean
flutter pub get
```

Then **File → Sync Project with Gradle Files** in Android Studio and **Run ▶** again.

### Missing cmdline-tools / licenses

In Android Studio: **Settings → Languages & Frameworks → Android SDK → SDK Tools**  
☑ Android SDK Command-line Tools → Apply  

Then:

```powershell
$env:PATH = "C:\Users\victoren\develop\flutter\bin;$env:PATH"
flutter doctor --android-licenses
```

### Invalid VCS root mapping

Open the **`mobile`** folder as the project root (not parent `Evabob`).  
If the warning remains: **Settings → Version Control** → remove the invalid mapping for `Evabob`.
