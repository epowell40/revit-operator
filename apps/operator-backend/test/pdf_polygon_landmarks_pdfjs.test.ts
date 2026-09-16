import assert from 'node:assert/strict';
import test from 'node:test';
import {loadPdfJsForNode,buildPdfJsDocumentOptions} from '../src/pdf/pdfjs_node.js';
import {extractCircularLabelCandidates as extract} from '../src/attachments/pdf_source_landmarks.js';

function polygonPdf(rotation:number, crop:boolean, explicitClose:boolean, reversed:boolean) {
 const points=Array.from({length:24},(_,i)=>{
  const angle=(reversed?-1:1)*i*Math.PI/12;
  return [100+5*Math.cos(angle),100+5*Math.sin(angle)];
 });
 if(!explicitClose)points.push(points[0]);
 const stream=points.map((p,i)=>`${p.join(' ')} ${i?'l':'m'}`).join('\n')+(explicitClose?'\nh S\n':'\nS\n')+'BT /F1 5 Tf 98.3325 98.7 Td (A) Tj ET\n';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',`<< /Type /Page /Parent 2 0 R /MediaBox [-40 -20 200 200] ${crop?'/CropBox [20 40 180 180]':''} /Rotate ${rotation} /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
 let output='%PDF-1.4\n';const offsets:number[]=[];
 objects.forEach((object,i)=>{offsets.push(Buffer.byteLength(output));output+=`${i+1} 0 obj\n${object}\nendobj\n`;});
 const xref=Buffer.byteLength(output);
 output+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
 return new Uint8Array(Buffer.from(output));
}

test('PDF.js polygon circles preserve coordinates through rotation, crop, path winding and closure',async()=>{
 const pdfjs=await loadPdfJsForNode();
 let cases=0;
 for(const rotation of [0,90,180,270])for(const crop of [false,true])for(const closed of [false,true])for(const reversed of [false,true]){
  const document=await pdfjs.getDocument({...buildPdfJsDocumentOptions(polygonPdf(rotation,crop,closed,reversed)),isEvalSupported:false}).promise;
  try {
   const page=await document.getPage(1),viewport=page.getViewport({scale:1});
   const result=extract({operatorList:await page.getOperatorList(),textContent:await page.getTextContent(),viewport,OPS:pdfjs.OPS});
   assert.equal(result.items.length,1,JSON.stringify({rotation,crop,closed,reversed,result}));
   const expected=viewport.convertToViewportPoint(100,100);
   assert.ok(Math.abs(result.items[0].center.u-expected[0]/viewport.width)<1e-6);
   assert.ok(Math.abs(result.items[0].center.v-expected[1]/viewport.height)<1e-6);
   assert.ok('visibility_not_established' in result && result.visibility_not_established === true);
   cases++;
  } finally {await document.destroy();}
 }
 assert.equal(cases,32);
});
