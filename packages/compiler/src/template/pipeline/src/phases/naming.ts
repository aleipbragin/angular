/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {sanitizeIdentifier} from '../../../../parse_util';
import {hyphenate} from '../../../../render3/view/style_parser';
import * as ir from '../../ir';
import {ViewCompilationUnit, type CompilationJob, type CompilationUnit} from '../compilation';

/**
 * Generate names for functions and variables across all views.
 *
 * This includes propagating those names into any `ir.ReadVariableExpr`s of those variables, so that
 * the reads can be emitted correctly.
 */
export function phaseNaming(cpl: CompilationJob): void {
  addNamesToView(
      cpl.root, cpl.componentName, {index: 0},
      cpl.compatibility === ir.CompatibilityMode.TemplateDefinitionBuilder);
}

function addNamesToView(
    unit: CompilationUnit, baseName: string, state: {index: number}, compatibility: boolean): void {
  if (unit.fnName === null) {
    unit.fnName = sanitizeIdentifier(`${baseName}_${unit.job.fnSuffix}`);
  }

  // Keep track of the names we assign to variables in the view. We'll need to propagate these
  // into reads of those variables afterwards.
  const varNames = new Map<ir.XrefId, string>();

  for (const op of unit.ops()) {
    switch (op.kind) {
      case ir.OpKind.Property:
      case ir.OpKind.HostProperty:
        if (op.isAnimationTrigger) {
          op.name = '@' + op.name;
        }
        break;
      case ir.OpKind.Listener:
        if (op.handlerFnName !== null) {
          break;
        }
        if (!op.hostListener && op.targetSlot.slot === null) {
          throw new Error(`Expected a slot to be assigned`);
        }
        let animation = '';
        if (op.isAnimationListener) {
          op.name = `@${op.name}.${op.animationPhase}`;
          animation = 'animation';
        }
        if (op.hostListener) {
          op.handlerFnName = `${baseName}_${animation}${op.name}_HostBindingHandler`;
        } else {
          op.handlerFnName = `${unit.fnName}_${op.tag!.replace('-', '_')}_${animation}${op.name}_${
              op.targetSlot.slot}_listener`;
        }
        op.handlerFnName = sanitizeIdentifier(op.handlerFnName);
        break;
      case ir.OpKind.Variable:
        varNames.set(op.xref, getVariableName(op.variable, state));
        break;
      case ir.OpKind.RepeaterCreate:
        if (!(unit instanceof ViewCompilationUnit)) {
          throw new Error(`AssertionError: must be compiling a component`);
        }
        if (op.slot.slot === null) {
          throw new Error(`Expected slot to be assigned`);
        }
        if (op.emptyView !== null) {
          const emptyView = unit.job.views.get(op.emptyView)!;
          // Repeater empty view function is at slot +2 (metadata is in the first slot).
          addNamesToView(
              emptyView, `${baseName}_${`${op.functionNameSuffix}Empty`}_${op.slot.slot + 2}`,
              state, compatibility);
        }
        // Repeater primary view function is at slot +1 (metadata is in the first slot).
        addNamesToView(
            unit.job.views.get(op.xref)!,
            `${baseName}_${op.functionNameSuffix}_${op.slot.slot + 1}`, state, compatibility);
        break;
      case ir.OpKind.Template:
        if (!(unit instanceof ViewCompilationUnit)) {
          throw new Error(`AssertionError: must be compiling a component`);
        }
        const childView = unit.job.views.get(op.xref)!;
        if (op.slot.slot === null) {
          throw new Error(`Expected slot to be assigned`);
        }
        const suffix = op.functionNameSuffix.length === 0 ? '' : `_${op.functionNameSuffix}`;
        addNamesToView(childView, `${baseName}${suffix}_${op.slot.slot}`, state, compatibility);
        break;
      case ir.OpKind.StyleProp:
        op.name = normalizeStylePropName(op.name);
        if (compatibility) {
          op.name = stripImportant(op.name);
        }
        break;
      case ir.OpKind.ClassProp:
        if (compatibility) {
          op.name = stripImportant(op.name);
        }
        break;
    }
  }

  // Having named all variables declared in the view, now we can push those names into the
  // `ir.ReadVariableExpr` expressions which represent reads of those variables.
  for (const op of unit.ops()) {
    ir.visitExpressionsInOp(op, expr => {
      if (!(expr instanceof ir.ReadVariableExpr) || expr.name !== null) {
        return;
      }
      if (!varNames.has(expr.xref)) {
        throw new Error(`Variable ${expr.xref} not yet named`);
      }
      expr.name = varNames.get(expr.xref)!;
    });
  }
}

function getVariableName(variable: ir.SemanticVariable, state: {index: number}): string {
  if (variable.name === null) {
    switch (variable.kind) {
      case ir.SemanticVariableKind.Context:
        variable.name = `ctx_r${state.index++}`;
        break;
      case ir.SemanticVariableKind.Identifier:
        // TODO: Prefix increment and `_r` for compatiblity only.
        variable.name = `${variable.identifier}_r${++state.index}`;
        break;
      default:
        // TODO: Prefix increment for compatibility only.
        variable.name = `_r${++state.index}`;
        break;
    }
  }
  return variable.name;
}

/**
 * Normalizes a style prop name by hyphenating it (unless its a CSS variable).
 */
function normalizeStylePropName(name: string) {
  return name.startsWith('--') ? name : hyphenate(name);
}

/**
 * Strips `!important` out of the given style or class name.
 */
function stripImportant(name: string) {
  const importantIndex = name.indexOf('!important');
  if (importantIndex > -1) {
    return name.substring(0, importantIndex);
  }
  return name;
}
