// A native file receipt proves its selected output, not that the selection
// honored an all-sheets request. Keep that source-scope check separate.
export function validateSheetExportScope(args={},result={}) {
 const specific=['sheet_number_prefix','sheetNumberPrefix','sheet_query','sheetQuery','query','print_set_name','printSetName']
  .some(key=>typeof args[key]==='string'&&args[key].trim())
  ||['sheet_number_prefixes','sheetNumberPrefixes','name_includes','nameIncludes'].some(key=>Array.isArray(args[key])&&args[key].length);
 if(args.all===false&&!specific)return '';
 const selection=result?.selection,count=result?.selectedCount??result?.matchedCount;
 if(!selection||!['selector','print_set'].includes(selection.kind))
  return 'PDF sheet selection was not confirmed: the native response fell back to an active view or omitted its selection scope. No all-sheets result is verified.';
 if(!Number.isSafeInteger(count)||count<1||selection.count!==count)
  return 'PDF sheet selection count does not match its native scope receipt.';
 if(selection.kind==='selector'&&selection.matchedCount!==undefined){
  if(!Number.isSafeInteger(selection.matchedCount)||selection.matchedCount<count||selection.truncated!==(selection.matchedCount>count))
   return 'PDF sheet selection coverage is inconsistent.';
  const maximum=Number(args.max),hasMaximum=Number.isSafeInteger(maximum)&&maximum>0;
  if(selection.truncated&&!hasMaximum)
   return `PDF selection was limited to ${count} of ${selection.matchedCount} matching sheets. Choose an explicit bounded selection before exporting.`;
 }
 return '';
}
