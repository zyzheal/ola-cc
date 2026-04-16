/* @ts-self-types="./string_width.d.ts" */
import * as wasm from "./string_width_bg.wasm";
import { __wbg_set_wasm } from "./string_width_bg.js";

__wbg_set_wasm(wasm);
wasm.__wbindgen_start();
export {
    string_width_wasm
} from "./string_width_bg.js";
