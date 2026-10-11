import {describe,expect,it} from 'vitest';
import type {PublishedReaderText,ReadingPositionUpdate} from '@folio/contracts';
import {assertPublishedReadingAnchor,InvalidReadingAnchor} from './reading-position.js';

const id=(n:number)=>String(n).padStart(8,'0')+'-1111-4111-8111-111111111111';
const book:PublishedReaderText={
  workId:id(1),revisionId:id(2),title:'Synthetic',language:'tr',
  chapters:[{id:id(3),heading:'Chapter',blocks:[
    {id:id(4),kind:'paragraph',text:'bir iki üç',includeRsvp:true},
    {id:id(5),kind:'footnote',text:'not',includeRsvp:false},
  ]}],
};
const base:ReadingPositionUpdate={
  expectedVersion:0,chapterId:id(3),blockId:id(4),
  tokenOffset:1,audioPositionMs:null,mode:'rsvp',
};
describe('immutable published owner progress anchors',()=>{
  it('accepts real RSVP offset and normal/audio chapter resume',()=>{
    expect(()=>assertPublishedReadingAnchor(book,base)).not.toThrow();
    expect(()=>assertPublishedReadingAnchor(book,{
      ...base,mode:'normal',tokenOffset:0,
    })).not.toThrow();
    expect(()=>assertPublishedReadingAnchor(book,{
      ...base,mode:'audio',tokenOffset:0,audioPositionMs:9500,
    })).not.toThrow();
  });
  it('rejects wrong chapter/block, hidden RSVP and out-of-range words',()=>{
    for(const candidate of [
      {...base,chapterId:id(8)}, {...base,blockId:id(9)},
      {...base,blockId:id(5)}, {...base,tokenOffset:3},
      {...base,mode:'normal' as const,audioPositionMs:100},
    ]){
      expect(()=>assertPublishedReadingAnchor(book,candidate)).toThrow(InvalidReadingAnchor);
    }
  });
});
