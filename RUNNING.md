# Running Soloist on your Android phone (from Windows)

You run two things:

1. **The lesson server** runs on your PC. It serves the lessons and backing tracks.
2. **The Soloist app** gets installed on your phone. It talks to the server over Wi-Fi.

Soloist contains custom native audio code (C++/Oboe). That means it **can't run in the Expo Go app**. You install
your own build of it, and there are two ways to get one:

| | Route A: cloud build (recommended) | Route B: build on your PC |
|---|---|---|
| What you install | Node.js, a free Expo account | Node.js, Android Studio, the Android NDK |
| First build | ~15–25 min on Expo's servers | ~10–20 min on your PC |
| Good for | Getting it on your phone with the least setup | Fast rebuilds while you hack on the native code |

---

## 0. One-time setup (both routes)

1. **Install Node.js 20 or 22 LTS** from <https://nodejs.org>. In PowerShell, `node -v` should print `v20.x` or `v22.x`.
2. **Unzip the project to a short path**, for example `C:\dev\soloist`.
   - Don't use Desktop, OneDrive or a deeply nested folder. Android's C++ build hits Windows' 260-character path
     limit there.
   - It's also worth turning on long paths once. Open PowerShell **as Administrator** and run:
     ```powershell
     New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force
     ```
3. **Connect your phone and PC to the same Wi-Fi network.** Guest networks often block devices from seeing each
   other, so use your main one.

## 1. Start the lesson server

```powershell
cd C:\dev\soloist\server
npm start
```

The first start generates the course: 25 songs with synthesized backing tracks, which takes a few seconds. Then it
prints something like:

```
Soloist mock API is running.
  On this computer:   http://localhost:4000
  From your phone:    http://192.168.1.23:4000   <- type this into Soloist > Settings > Server
```

- If **Windows Defender Firewall** pops up, tick **Private networks** and click **Allow**. If you missed the popup, go to
  Windows Security → Firewall → Allow an app → Node.js → tick Private.
- **Check it from your phone:** open Chrome on the phone and go to `http://192.168.1.23:4000/v1/health` (use your own
  address). You should see `{"ok":true,...}`. If you don't, fix this before going further (see *Troubleshooting*).

Leave this window open whenever you want to play.

## 2. Install the app's dependencies

Open a **second** PowerShell window:

```powershell
cd C:\dev\soloist\app
npm install
npx expo install --fix     # aligns every package with Expo SDK 54
npm test                   # optional: grading, game rules and store tests
```

---

## Route A: build in Expo's cloud (recommended)

### A1. Create the build (about 20 minutes, once)

```powershell
npm install -g eas-cli
eas login                  # create a free account at expo.dev if you don't have one
eas init                   # links the project to your account (answer Yes)
eas build --platform android --profile development
```

- When it asks to **generate a new Android Keystore**, answer **Yes**.
- When the build finishes, the terminal shows a **QR code and a link**.

### A2. Install it on the phone

1. Scan the QR code with the phone's camera (or open the link) and download the `.apk`.
2. Android will ask to **allow installs from this source**. Allow it for your browser, then tap **Install**.
   Play Protect may warn about an unknown app; choose **Install anyway**.

You now have a "development build": the Soloist app with all its native code, which loads its screens from your PC.

### A3. Run it

On the PC, in the `app` folder:

```powershell
npx expo start --dev-client
```

Open **Soloist** on the phone. It lists the development server running on your PC (or you can scan the QR code shown
in the terminal), and the app loads. Because the app knows your PC's address from this connection, **the lesson server
is found automatically**.

- If you edit any TypeScript, it reloads instantly. Press `r` in the terminal to force a reload.
- If you change C++, Kotlin, `app.json` plugins or native packages, rebuild with `eas build ... --profile development`.

### A-bis. A standalone APK (no PC needed for the app itself)

```powershell
eas build --platform android --profile preview
```

This APK contains the whole app, so you don't need `expo start`. The lesson server is still needed, though. On first
launch, enter the address the server printed (e.g. `192.168.1.23:4000`) on the **Connect to your lesson server**
step. You can change it later under ⚙️ Settings → Lesson server.

---

## Route B: build on your PC with Android Studio

1. Install **Android Studio** from <https://developer.android.com/studio>. It includes the Java 17 runtime Gradle needs.
2. Android Studio → **More Actions → SDK Manager**:
   - **SDK Platforms:** Android 16 (API 36).
   - **SDK Tools:** tick **Show Package Details**, then install **NDK (Side by side) 27.1.12297006**,
     **CMake 3.22.1** and **Android SDK Platform-Tools**.
3. Set environment variables (Start → "Edit the system environment variables" → Environment Variables):
   - `ANDROID_HOME` = `C:\Users\<you>\AppData\Local\Android\Sdk`
   - Add `%ANDROID_HOME%\platform-tools` to `Path`.
   - Reopen PowerShell, then check that `adb version` works.
4. On the phone, enable **Developer options** (Settings → About phone → tap *Build number* 7 times). Then turn on
   **USB debugging** under Developer options. Plug in the USB cable and accept the "Allow USB debugging?" prompt.
   `adb devices` should list the phone.
5. Build, install and run:
   ```powershell
   cd C:\dev\soloist\app
   npx expo run:android --device
   ```
   The first build compiles React Native, Skia and Soloist's C++ engine, so it takes a while. Later builds are fast.
   Metro starts automatically, and the lesson server is auto-detected the same way as in Route A.

---

## 3. First launch

The app walks you through:

1. **Experience.** If you already play, Soloist skips the basics for you.
2. **Daily goal.** One 3-minute lesson earns roughly 20–30 XP.
3. **Server.** This should say ✓ Connected. If it doesn't, type the address the server printed.
4. **Microphone.** Tap Allow. The audio is analysed on the phone and never recorded or uploaded.
5. **Tune up.** Use the built-in tuner (E A D G B E).
6. **Latency check (20 s).** Unplug headphones, turn the volume up and stay quiet. This measures your phone's exact
   audio delay so grading is fair. You can redo it any time from Settings.

### Tips for good detection

- **Acoustic guitar:** hold the phone 30–60 cm from the sound hole, in a quiet room.
- **Electric guitar:** an unplugged electric is too quiet. Play through an amp, or plug the guitar into a USB audio
  interface connected to the phone (USB-C or an OTG adapter). Android handles that as the mic and speaker.
- **Headphones:** wired or USB headphones stop the backing track leaking into the mic. **Avoid Bluetooth**, which adds
  100–300 ms of delay; the app warns you if Bluetooth is connected.

## 4. What's in the app

| Screen | What it does |
|---|---|
| **Home** | Streak 🔥, hearts ♥, daily-goal and level bars, a *Continue* button and the skill tree (8 skills, 24 lessons). |
| **Skill** | Lessons for that skill, your crowns, and **Practice** buttons for every exercise. |
| **Lesson** | The 3-minute session in landscape: count-in, scrolling tab, live combo and score, then a review with stars and rushing/dragging feedback. A failed exercise costs a ♥. |
| **Practice** | Loop any bars, slow down to 50–90 %, mute the guide, bass or click. Each loop pass is scored. Finishing practice earns XP and **wins back a heart**. |
| **🎚 Tuner** | Chromatic tuner that tells you which string you're nearest to. |
| **📈 Progress** | Level, 7-day XP chart, timing tendency, recent sessions, hearts, streak freezes. |
| **⚙️ Settings** | Daily goal, grading strictness, highway speed, guide-track mode, haptics, server address, latency nudge and recheck, audio diagnostics, cache and reset. |

## 5. Troubleshooting

| Symptom | Fix |
|---|---|
| **"Can't reach the lesson server"** | Is `npm start` still running? Is the phone on the same Wi-Fi (not guest)? Does `http://<PC-IP>:4000/v1/health` open in the phone's browser? If not, allow Node.js through Windows Firewall on **Private** networks, and make sure your Wi-Fi is set to **Private** in Windows network settings. PC IP addresses can change: check what the server printed and update Settings → Lesson server. |
| **"Cannot find native module 'SoloistAudio'"** | You opened the project in **Expo Go**. Use your Soloist build (Route A or B) instead. |
| Build error mentioning **path too long / Filename longer than 260 characters** | Move the project to `C:\dev\soloist` and enable long paths (step 0). |
| Build error about **NDK / CMake not found** (Route B) | Install NDK 27.1.12297006 and CMake 3.22.1 in SDK Manager, and check that `ANDROID_HOME` is set. |
| `npx expo install --fix` changes versions | That's expected. It pins everything to the versions Expo SDK 54 was tested with. |
| **Notes aren't detected** | Turn the guitar up, move the phone closer, use a quieter room. Run 🎚 Tuner: if it doesn't react, the mic isn't hearing you. Check Settings → Audio diagnostics. |
| **Always graded early or late** | Re-run the latency check (no headphones, volume up). If it's still off, use the ±1/±5 ms nudge buttons in Settings → Latency. |
| **Mic permission denied** | Phone Settings → Apps → Soloist → Permissions → Microphone → Allow, then tap *Try again*. |
| **Crackles or dropouts** | Close other audio apps. Battery saver can throttle the audio thread, so turn it off while playing. |

## 6. Running the tests

```powershell
cd C:\dev\soloist\server; npm test                           # API: 7 tests
cd C:\dev\soloist\app;    npm test                           # grading, game rules, store, sync controller
```

The C++ engine tests need a C++ compiler (g++/clang, e.g. from WSL or MSYS2):

```bash
cd app/modules/soloist-audio
npm run test:core   # onset/pitch stress test + loop/clock/tuner tests
npm run test:e2e    # every generated guide track through the engine (needs server content generated)
```
