import {describe,expect,it} from 'vitest';
import {preparedAudioAssetSchema,audioVariantInputSchema} from '@folio/contracts';
const uid='3ccab685-4656-4677-a9c9-8f27c57ae899';
const asset={storageKey:'private/test/ready-audio.m4a',sha256:'a'.repeat(64),sizeBytes:4000,mime:'audio/mp4',durationMs:10000};
const segment={chapterId:uid,ordinal:0,assetId:uid,textBlockId:uid,textSha256:'b'.repeat(64),startMs:0,endMs:1000};
describe('prepared audio metadata contracts',()=>{
  it('accepts only declared formats and positive size/duration with cryptographic metadata',()=>{
    expect(preparedAudioAssetSchema.safeParse(asset).success).toBe(true);
    expect(preparedAudioAssetSchema.safeParse({...asset,sizeBytes:0}).success).toBe(false);
    expect(preparedAudioAssetSchema.safeParse({...asset,mime:'audio/mpeg'}).success).toBe(false);
    expect(preparedAudioAssetSchema.safeParse({...asset,sha256:'unknown'}).success).toBe(false);
  });
  it('rejects invalid timestamps and duplicate segment ordinal',()=>{
    const base={contentRevisionId:uid,language:'tr',voiceId:'prepared.voice.1',sourceLabel:'Human ready narration',codec:'m4a',segments:[segment]};
    expect(audioVariantInputSchema.safeParse(base).success).toBe(true);
    expect(audioVariantInputSchema.safeParse({...base,segments:[{...segment,endMs:0}]}).success).toBe(false);
    expect(audioVariantInputSchema.safeParse({...base,segments:[segment,segment]}).success).toBe(false);
  });
});
