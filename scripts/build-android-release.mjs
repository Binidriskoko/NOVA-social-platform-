import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const expectedCertificateFingerprint = 'C81B2766C700A37A096C7A26F4F92DA73480F55F6221D1C660AC90F4508007DE'
const publishedV110CertificateFingerprint = 'AF616784DF6B2E4BDF9D34A24524F5C381CFDF3BFC710EF825F10224D4156503'
const projectRoot = resolve(import.meta.dirname, '..')
const downloadPageUrl = 'https://github.com/Binidriskoko/NOVA-social-platform-/releases/latest'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

function requireEnvironment(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable ${name}.`)
  return value
}

const gradle = await readFile(join(projectRoot, 'android/app/build.gradle'), 'utf8')
const versionCode = Number(gradle.match(/versionCode\s+(\d+)/)?.[1])
const versionName = gradle.match(/versionName\s+"([^"]+)"/)?.[1]
if (!Number.isSafeInteger(versionCode) || !versionName) {
  throw new Error('Unable to read Android versionCode/versionName from android/app/build.gradle.')
}
const releaseConfig = await readFile(join(projectRoot, 'src/config/release.ts'), 'utf8')
const configuredVersionCode = Number(releaseConfig.match(/ANDROID_VERSION_CODE\s*=\s*(\d+)/)?.[1])
const configuredVersionName = releaseConfig.match(/APP_VERSION_NAME\s*=\s*'([^']+)'/)?.[1]
if (configuredVersionCode !== versionCode || configuredVersionName !== versionName) {
  throw new Error('Android Gradle version and src/config/release.ts must match before publishing.')
}

const metadata = JSON.parse(await readFile(join(projectRoot, 'public/release-metadata.json'), 'utf8'))
if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
  || typeof metadata.versionName !== 'string'
  || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(metadata.versionName)
  || !Number.isSafeInteger(metadata.versionCode)
  || typeof metadata.releaseNotes !== 'string' || !metadata.releaseNotes.trim()
  || typeof metadata.releaseDate !== 'string' || !Number.isFinite(Date.parse(metadata.releaseDate))
  || !Number.isSafeInteger(metadata.minSupportedVersionCode)
  || metadata.minSupportedVersionCode < 1 || metadata.minSupportedVersionCode > metadata.versionCode
  || metadata.downloadPageUrl !== downloadPageUrl) {
  throw new Error('public/release-metadata.json does not contain valid release metadata.')
}
if (metadata.versionCode !== versionCode || metadata.versionName !== versionName) {
  throw new Error('Android Gradle version and release-metadata.json must match before publishing.')
}
if (expectedCertificateFingerprint !== publishedV110CertificateFingerprint) {
  throw new Error(
    'The public v1.1.0 APK is signed with an Android Debug certificate, not the pinned release certificate. '
    + 'A different signing identity cannot update existing installs; refusing to publish until the signing-identity migration is explicitly resolved.',
  )
}
if (process.env.GITHUB_REF_NAME && process.env.GITHUB_REF_NAME !== `v${versionName}`) {
  throw new Error(`Tag ${process.env.GITHUB_REF_NAME} does not match Android version v${versionName}.`)
}
const keystorePath = requireEnvironment('ANDROID_KEYSTORE_PATH')
requireEnvironment('ANDROID_KEYSTORE_PASSWORD')
requireEnvironment('ANDROID_KEY_ALIAS')
requireEnvironment('ANDROID_KEY_PASSWORD')
try {
  await stat(keystorePath)
} catch (error) {
  if (error.code === 'ENOENT') throw new Error('ANDROID_KEYSTORE_PATH does not point to an existing file.')
  throw error
}

const certificate = run('keytool', [
  '-exportcert', '-rfc', '-keystore', keystorePath,
  '-storepass:env', 'ANDROID_KEYSTORE_PASSWORD',
  '-alias', process.env.ANDROID_KEY_ALIAS,
])
const fingerprintOutput = run('openssl', ['x509', '-noout', '-fingerprint', '-sha256'], {
  input: certificate,
})
const fingerprint = fingerprintOutput.split('=').at(-1)?.replaceAll(':', '').toUpperCase()
if (fingerprint !== expectedCertificateFingerprint) {
  throw new Error('Signing certificate does not match the existing public APK; refusing to build a purported update.')
}

const sdkRoot = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME
if (!sdkRoot) throw new Error('Set ANDROID_SDK_ROOT or ANDROID_HOME to an installed Android SDK.')
const buildToolsRoot = join(sdkRoot, 'build-tools')
const buildTools = (await readdir(buildToolsRoot)).sort((left, right) =>
  right.localeCompare(left, undefined, { numeric: true }),
).find((version) => version.startsWith('35.'))
if (!buildTools) throw new Error('Android SDK Build Tools 35.x are required.')
const toolsDirectory = join(buildToolsRoot, buildTools)
const apksigner = join(toolsDirectory, 'apksigner')
const aapt = join(toolsDirectory, 'aapt')

run('npm', ['run', 'build'])
const webAssetsDirectory = join(projectRoot, 'dist/assets')
const webBundles = (await readdir(webAssetsDirectory)).filter((name) => name.endsWith('.js'))
const productionApiBundle = await Promise.all(
  webBundles.map(async (name) => ({
    name,
    content: await readFile(join(webAssetsDirectory, name), 'utf8'),
  })),
).then((bundles) => bundles.find(({ content }) =>
  content.includes('https://nova-social-platform-api.onrender.com'),
))
if (!productionApiBundle) {
  throw new Error('Production web bundle does not include the configured NOVAKOKO API endpoint.')
}
run('npx', ['cap', 'sync', 'android'])
run('./gradlew', ['assembleRelease', '--no-daemon'], { cwd: join(projectRoot, 'android') })

const unsignedOrSignedApk = join(projectRoot, 'android/app/build/outputs/apk/release/app-release.apk')
const packagedApiBundle = run('unzip', [
  '-p', unsignedOrSignedApk, `assets/public/assets/${productionApiBundle.name}`,
])
if (!packagedApiBundle.includes('https://nova-social-platform-api.onrender.com')) {
  throw new Error('Built APK does not contain the production API web bundle.')
}
const signatureOutput = run(apksigner, ['verify', '--print-certs', unsignedOrSignedApk])
const apkFingerprint = signatureOutput.match(/Signer #1 certificate SHA-256 digest:\s*([a-fA-F0-9]+)/)?.[1]
if (apkFingerprint?.toUpperCase() !== expectedCertificateFingerprint) {
  throw new Error('Built APK signature does not match the existing public APK certificate.')
}

const badging = run(aapt, ['dump', 'badging', unsignedOrSignedApk])
const packageInfo = badging.match(/package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/)
if (!packageInfo
  || packageInfo[1] !== 'com.novakoko.app'
  || Number(packageInfo[2]) !== versionCode
  || packageInfo[3] !== versionName) {
  throw new Error('Built APK metadata does not match the expected application ID and release version.')
}

const outputDirectory = join(projectRoot, 'release-artifacts')
await mkdir(outputDirectory, { recursive: true })
const apkName = `NOVAKOKO-v${versionName}.apk`
const apkPath = join(outputDirectory, apkName)
await copyFile(unsignedOrSignedApk, apkPath)
await chmod(apkPath, 0o644)
const checksum = createHash('sha256').update(await readFile(apkPath)).digest('hex')
await writeFile(`${apkPath}.sha256`, `${checksum}  ${apkName}\n`)
console.log(`Verified ${apkPath} (${(await stat(apkPath)).size} bytes)`)
console.log(`SHA-256 ${checksum}`)
