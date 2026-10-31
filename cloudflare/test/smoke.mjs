import {makeXlsx} from '../src/xlsx.js';
import {writeFileSync} from 'node:fs';
writeFileSync(new URL('./test-workbook.xlsx', import.meta.url),makeXlsx([['Тест',['Имя','Сумма'],[['=SUM(1,2)',42],['Шоппер',250000]]]]));
console.log("XLSX_WRITTEN");
