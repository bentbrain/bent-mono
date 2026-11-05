import sharp from 'sharp';
import { check } from './contract.mjs';

export async function comparePrints(output, baseline) {
  const native = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const reference = await sharp(baseline).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  check(JSON.stringify(native.info) === JSON.stringify(reference.info), 'print shape and channels');
  let squared = 0, absolute = 0, alpha = 0;
  for (let i = 0; i < native.data.length; i++) {
    const difference = Math.abs(native.data[i] - reference.data[i]);
    squared += difference * difference; absolute += difference;
    if (i % 4 === 3) alpha += difference;
  }
  return { meanAbsoluteChannelDifference: absolute / native.data.length,
    channelRmse: Math.sqrt(squared / native.data.length), meanAbsoluteAlphaDifference: alpha / (native.data.length / 4) };
}
