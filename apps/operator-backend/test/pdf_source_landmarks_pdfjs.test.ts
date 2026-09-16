import assert from 'node:assert/strict';
import test from 'node:test';
import {loadPdfJsForNode,buildPdfJsDocumentOptions} from '../src/pdf/pdfjs_node.js';
import {extractCircularLabelCandidates} from '../src/attachments/pdf_source_landmarks.js';
import {circularLabelPdf} from './pdf_source_landmarks.fixtures.js';
test('actual pdfjs decodes synthetic circle center across four rotations and cropped pages',async()=>{
 const pdfjs=await loadPdfJsForNode();
 for(const rotation of [0,90,180,270])for(const crop of [false,true]){
  const doc=await pdfjs.getDocument({...buildPdfJsDocumentOptions(new Uint8Array(circularLabelPdf(rotation,crop))),isEvalSupported:false}).promise;
  try{const page=await doc.getPage(1),viewport=page.getViewport({scale:1});const result=extractCircularLabelCandidates({operatorList:await page.getOperatorList(),textContent:await page.getTextContent(),viewport,OPS:pdfjs.OPS});assert.equal(result.items.length,1,JSON.stringify({rotation,crop,result}));const expected=viewport.convertToViewportPoint(100,100);assert.ok(Math.abs(result.items[0].center.u-expected[0]/viewport.width)<1e-6);assert.ok(Math.abs(result.items[0].center.v-expected[1]/viewport.height)<1e-6);}finally{await doc.destroy();}
 }
});
