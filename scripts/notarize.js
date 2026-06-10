const { notarize } = require('@electron/notarize');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 加载 .env 文件
require('dotenv').config();

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;

  if (electronPlatformName !== 'darwin') {
    return;
  }

  if (!process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD) {
    console.warn('⚠️  跳过公证: 未设置 APPLE_ID 或 APPLE_APP_SPECIFIC_PASSWORD');
    console.warn('   如需启用公证，请创建 .env 文件并配置 Apple Developer 凭据');
    console.warn('   参考 .env.example 模板');
    return;
  }

  if (!process.env.APPLE_TEAM_ID) {
    console.warn('⚠️  跳过公证: 未设置 APPLE_TEAM_ID');
    console.warn('   公证需要 APPLE_TEAM_ID');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  console.log(`🔐 正在公证 ${appName}...`);
  console.log(`   应用路径: ${appPath}`);
  console.log(`   Apple ID: ${process.env.APPLE_ID}`);
  console.log(`   Team ID: ${process.env.APPLE_TEAM_ID}`);

  // Re-sign the entire bundle with --deep so the 8 newly-embedded bundled
  // runtimes (node, python, git, gh, claudecode, codex, hermes, openclaw)
  // inherit the app's signature and entitlements. Without --deep, each
  // embedded binary would still carry the upstream publisher's signature
  // (Node.js Foundation, Python Software Foundation, GitHub, etc.) and
  // could fail Gatekeeper validation.
  const identity = process.env.APP_IDENTITY || `Developer ID Application: ${process.env.APPLE_TEAM_ID}`;
  if (fs.existsSync(appPath)) {
    console.log(`🔏 Re-signing bundle with codesign --deep --sign "${identity}"`);
    execFileSync('codesign', ['--force', '--deep', '--sign', identity, appPath], { stdio: 'inherit' });
  }

  try {
    await notarize({
      appPath: appPath,
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    });

    console.log('✅ 公证成功！');
    console.log('   应用已签名并通过公证，可以分发给用户');
  } catch (error) {
    console.error('❌ 公证失败:', error.message);
    console.error('   请检查 Apple Developer 凭据并重试');
    console.error('   访问 https://appstoreconnect.apple.com/notarization-history 查看详情');
    throw error;
  }
};
