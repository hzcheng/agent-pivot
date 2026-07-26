'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const assets = [
    {
        input: 'media/brand/agent-pivot-marketplace.svg',
        output: 'media/extension_icon.png',
    },
    {
        input: 'media/brand/agent-pivot-bridge-marketplace.svg',
        output: 'extensions/attention-ui-bridge/media/extension_icon.png',
    },
];

const UNSAFE_SVG_CONTENT = /<script|href=|xlink:href|url\(|<image|<foreignObject/i;

function validateSvgSource(source, label) {
    if (UNSAFE_SVG_CONTENT.test(source)) {
        throw new Error(`${label} contains external or active SVG content`);
    }
}

async function renderSvg(source, rasterizer = sharp) {
    return rasterizer(Buffer.from(source))
        .resize(256, 256, { fit: 'fill' })
        .png({ compressionLevel: 9, adaptiveFiltering: false })
        .toBuffer();
}

async function updateAsset({ inputPath, outputPath, check, rasterizer = sharp, fsApi = fs }) {
    const source = fsApi.readFileSync(inputPath, 'utf8');
    validateSvgSource(source, inputPath);
    const rendered = await renderSvg(source, rasterizer);
    const metadata = await rasterizer(rendered).metadata();
    assert.deepEqual(
        {
            format: metadata.format,
            width: metadata.width,
            height: metadata.height,
            channels: metadata.channels,
        },
        { format: 'png', width: 256, height: 256, channels: 4 }
    );

    if (check) {
        if (!fsApi.existsSync(outputPath)
            || !rendered.equals(fsApi.readFileSync(outputPath))) {
            throw new Error(`${path.relative(process.cwd(), outputPath)} is stale; run npm run brand:generate`);
        }
        return;
    }

    fsApi.mkdirSync(path.dirname(outputPath), { recursive: true });
    const temporaryPath = `${outputPath}.tmp`;
    let completed = false;
    try {
        fsApi.writeFileSync(temporaryPath, rendered);
        fsApi.renameSync(temporaryPath, outputPath);
        completed = true;
    } finally {
        if (!completed && fsApi.existsSync(temporaryPath)) {
            fsApi.unlinkSync(temporaryPath);
        }
    }
}

async function main() {
    const check = process.argv.slice(2).includes('--check');
    const repositoryRoot = process.cwd();
    for (const asset of assets) {
        await updateAsset({
            inputPath: path.join(repositoryRoot, asset.input),
            outputPath: path.join(repositoryRoot, asset.output),
            check,
        });
    }
    if (check) {
        console.log('Brand assets are current.');
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = { renderSvg, updateAsset, validateSvgSource };
