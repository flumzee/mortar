const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

/**
 * Ad-hoc signs the macOS app.
 *
 * Apple Silicon will not execute a binary carrying no code signature at all,
 * and the failure surfaces to the user as "Mortar is damaged and can't be
 * opened" rather than anything about signing. Notarizing needs a paid Developer
 * ID, but an ad-hoc signature costs nothing and is enough to make the app
 * runnable once the user clears quarantine.
 *
 * electron-builder skips its own signing here (CSC_IDENTITY_AUTO_DISCOVERY is
 * false because there is no identity to find), so this runs instead. It has to
 * happen in afterPack: the DMG and zip are built from this directory right
 * after, and they need to contain the already-signed bundle.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  const sign = (target) =>
    execFileSync("codesign", ["--force", "--sign", "-", "--timestamp=none", target], {
      stdio: "inherit",
    });

  // The Claude CLI lives outside the asar and is spawned as its own process, so
  // it needs its own signature. --deep does not reliably reach into Resources.
  // Both arch names are checked rather than mapping electron-builder's Arch
  // enum, which is an opaque number here.
  const vendor = path.join(
    app,
    "Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai",
  );
  const cli = ["arm64", "x64"]
    .map((arch) => path.join(vendor, `claude-agent-sdk-darwin-${arch}`, "claude"))
    .find(existsSync);

  if (cli) {
    sign(cli);
    console.log(`  • ad-hoc signed ${path.relative(app, cli)}`);
  } else {
    console.warn(`  • no Claude CLI binary found under ${vendor}`);
  }

  execFileSync(
    "codesign",
    ["--force", "--deep", "--sign", "-", "--timestamp=none", app],
    { stdio: "inherit" },
  );
  console.log(`  • ad-hoc signed ${path.basename(app)}`);

  // Fail the build rather than ship another bundle that cannot launch.
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  console.log("  • signature verified");
};
