// The only module that may import rxjs directly. Our own operators and bridges hang off `Ext`, so a
// call site reads `Rx.map` for rxjs's and `Rx.Ext.traceTag` for ours, out of one namespace.
//
// `export * as Ext` rather than `export namespace Ext`: the latter compiles to an IIFE with no pure
// annotation, which would keep the whole rxjs re-export alive in the client bundle.
export * from 'rxjs'
export * as Ext from './rxjs-ext'
