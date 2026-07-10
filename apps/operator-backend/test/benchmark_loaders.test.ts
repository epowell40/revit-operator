import test from "node:test";
import assert from "node:assert/strict";
import { loadBenchmarkConfigBundle } from "../src/benchmark/config.js";
import { loadBenchmarkTasks } from "../src/benchmark/tasks.js";

test("benchmark config bundle exposes the expected default configs", () => {
  const bundle = loadBenchmarkConfigBundle();
  const configIds = bundle.configs.map((config) => config.id);
  assert.equal(bundle.baseline_config_id, "single_55_medium");
  assert.deepEqual(bundle.phase1_config_ids, [
    "single_55_medium",
    "split_55_high__55_low",
    "split_55_medium__55_instant",
    "split_55_medium__54mini_low",
    "deterministic_skill_only"
  ]);
  assert.ok(bundle.default_phase1_task_ids.includes("demo_redline_mep_route"));
  assert.ok(bundle.default_phase1_task_ids.includes("demo_redline_mep_pipe_route"));
  assert.ok(bundle.default_phase1_task_ids.includes("demo_redline_update_parameter"));
  assert.ok(bundle.default_phase1_task_ids.includes("demo_redline_text_edit_mep_accessory"));
  assert.ok(bundle.default_phase1_task_ids.includes("demo_redline_add_tag"));
  assert.ok(bundle.default_phase1_task_ids.includes("demo_redline_add_family_instance"));
  assert.ok(bundle.default_phase1_task_ids.includes("demo_redline_add_receptacle"));
  assert.ok(bundle.default_phase1_task_ids.includes("demo_redline_add_light"));
  assert.ok(bundle.default_phase1_task_ids.includes("demo_redline_add_mep_accessory"));
  assert.ok(bundle.default_phase1_task_ids.includes("demo_redline_delete_text"));
  assert.ok(bundle.default_phase1_task_ids.includes("demo_redline_delete_tag"));
  assert.ok(bundle.default_phase1_task_ids.includes("demo_redline_delete_family_instance"));
  assert.ok(bundle.default_phase1_task_ids.includes("demo_redline_delete_receptacle"));
  assert.ok(bundle.default_phase1_task_ids.includes("demo_redline_delete_light"));
  assert.ok(bundle.default_phase1_task_ids.includes("demo_redline_delete_duct_route"));
  assert.ok(bundle.default_phase1_task_ids.includes("demo_redline_delete_pipe_route"));
  assert.ok(bundle.default_phase1_task_ids.includes("demo_redline_delete_mep_accessory"));
  assert.ok(bundle.default_phase1_task_ids.includes("demo_redline_move_text"));
  assert.ok(bundle.default_phase1_task_ids.includes("demo_redline_move_tag"));
  assert.ok(bundle.default_phase1_task_ids.includes("demo_redline_move_family_instance"));
  assert.ok(bundle.default_phase1_task_ids.includes("demo_redline_move_receptacle"));
  assert.ok(bundle.default_phase1_task_ids.includes("demo_redline_move_light"));
  assert.ok(bundle.default_phase1_task_ids.includes("demo_redline_move_mep_accessory"));
  assert.ok(bundle.default_phase1_task_ids.includes("demo_redline_move_duct_route"));
  assert.ok(bundle.default_phase1_task_ids.includes("demo_redline_move_pipe_route"));
  assert.ok(bundle.default_phase1_task_ids.includes("demo_redline_rotate_text"));
  assert.ok(bundle.default_phase1_task_ids.includes("demo_redline_type_change_device"));
  assert.ok(bundle.default_phase1_task_ids.includes("demo_redline_type_change_duct"));
  assert.ok(bundle.default_phase1_task_ids.includes("demo_redline_type_change_mep_accessory"));
  assert.ok(bundle.default_phase1_task_ids.includes("demo_documentation_primitives"));
  assert.ok(bundle.default_phase1_task_ids.includes("demo_model_edit_primitives"));
  assert.ok(configIds.includes("deterministic_skill_only"));
  assert.ok(configIds.includes("single_54mini_none"));
});

test("benchmark task loader discovers demo Revit workflow tasks", () => {
  const tasks = loadBenchmarkTasks();
  const taskIds = tasks.map((task) => task.task_id);
  assert.ok(taskIds.includes("demo_sheet_export"));
  assert.ok(taskIds.includes("demo_takeoff_receptacles"));
  assert.ok(taskIds.includes("demo_parameter_edit"));
  assert.ok(taskIds.includes("demo_redline_update_parameter"));
  assert.ok(taskIds.includes("demo_redline_text_edit_mep_accessory"));
  assert.ok(taskIds.includes("demo_redline_receptacles"));
  assert.ok(taskIds.includes("demo_redline_mep_route"));
  assert.ok(taskIds.includes("demo_redline_mep_pipe_route"));
  assert.ok(taskIds.includes("demo_redline_mep_pipe_tap_branch"));
  assert.ok(taskIds.includes("demo_redline_mep_duct_reroute"));
  assert.ok(taskIds.includes("demo_redline_mep_pipe_reroute"));
  assert.ok(taskIds.includes("demo_redline_mep_duct_size_transition"));
  assert.ok(taskIds.includes("demo_redline_mep_pipe_size_transition"));
  assert.ok(taskIds.includes("demo_redline_add_tag"));
  assert.ok(taskIds.includes("demo_redline_add_family_instance"));
  assert.ok(taskIds.includes("demo_redline_add_receptacle"));
  assert.ok(taskIds.includes("demo_redline_add_light"));
  assert.ok(taskIds.includes("demo_redline_add_mep_accessory"));
  assert.ok(taskIds.includes("demo_redline_delete_text"));
  assert.ok(taskIds.includes("demo_redline_delete_tag"));
  assert.ok(taskIds.includes("demo_redline_delete_family_instance"));
  assert.ok(taskIds.includes("demo_redline_delete_receptacle"));
  assert.ok(taskIds.includes("demo_redline_delete_light"));
  assert.ok(taskIds.includes("demo_redline_delete_duct_route"));
  assert.ok(taskIds.includes("demo_redline_delete_pipe_route"));
  assert.ok(taskIds.includes("demo_redline_delete_mep_accessory"));
  assert.ok(taskIds.includes("demo_redline_move_text"));
  assert.ok(taskIds.includes("demo_redline_move_tag"));
  assert.ok(taskIds.includes("demo_redline_move_family_instance"));
  assert.ok(taskIds.includes("demo_redline_move_receptacle"));
  assert.ok(taskIds.includes("demo_redline_move_light"));
  assert.ok(taskIds.includes("demo_redline_move_mep_accessory"));
  assert.ok(taskIds.includes("demo_redline_move_duct_route"));
  assert.ok(taskIds.includes("demo_redline_move_pipe_route"));
  assert.ok(taskIds.includes("demo_redline_rotate_text"));
  assert.ok(taskIds.includes("demo_redline_type_change_device"));
  assert.ok(taskIds.includes("demo_redline_type_change_duct"));
  assert.ok(taskIds.includes("demo_redline_type_change_mep_accessory"));
  assert.ok(taskIds.includes("demo_documentation_primitives"));
  assert.ok(taskIds.includes("demo_model_edit_primitives"));
  for (const id of [
    "demo_sheet_export",
    "demo_takeoff_receptacles",
    "demo_parameter_edit",
    "demo_redline_update_parameter",
    "demo_redline_text_edit_mep_accessory",
    "demo_redline_receptacles",
    "demo_redline_add_tag",
    "demo_redline_add_family_instance",
    "demo_redline_add_receptacle",
    "demo_redline_add_light",
    "demo_redline_add_mep_accessory",
    "demo_redline_delete_text",
    "demo_redline_delete_tag",
    "demo_redline_delete_family_instance",
    "demo_redline_delete_receptacle",
    "demo_redline_delete_light",
    "demo_redline_delete_duct_route",
    "demo_redline_delete_pipe_route",
    "demo_redline_delete_mep_accessory",
    "demo_redline_move_text",
    "demo_redline_move_tag",
    "demo_redline_move_family_instance",
    "demo_redline_move_receptacle",
    "demo_redline_move_light",
    "demo_redline_move_mep_accessory",
    "demo_redline_move_duct_route",
    "demo_redline_move_pipe_route",
    "demo_redline_rotate_text",
    "demo_redline_type_change_device",
    "demo_redline_type_change_duct",
    "demo_redline_type_change_mep_accessory",
    "demo_redline_mep_route",
    "demo_redline_mep_pipe_route",
    "demo_redline_mep_pipe_tap_branch",
    "demo_redline_mep_duct_reroute",
    "demo_redline_mep_pipe_reroute",
    "demo_redline_mep_duct_size_transition",
    "demo_redline_mep_pipe_size_transition",
    "demo_documentation_primitives",
    "demo_model_edit_primitives"
  ]) {
    assert.equal(tasks.find((task) => task.task_id === id)?.environment.adapter_id, "revit_workflow");
  }
  const redlineAddTag = tasks.find((task) => task.task_id === "demo_redline_add_tag");
  assert.equal(redlineAddTag?.adapter_config?.workflow, "redline_add");
  assert.equal((redlineAddTag?.adapter_config?.request as any)?.targetKind, "tag");
  assert.match(redlineAddTag?.success_criteria.join(" ") ?? "", /disposable tag id.*visible/is);
  const redlineAddFamilyInstance = tasks.find((task) => task.task_id === "demo_redline_add_family_instance");
  assert.equal(redlineAddFamilyInstance?.adapter_config?.workflow, "redline_add");
  assert.equal((redlineAddFamilyInstance?.adapter_config?.request as any)?.targetKind, "family_instance");
  assert.match(redlineAddFamilyInstance?.success_criteria.join(" ") ?? "", /family instance id.*visible/is);
  const redlineAddReceptacle = tasks.find((task) => task.task_id === "demo_redline_add_receptacle");
  assert.equal(redlineAddReceptacle?.adapter_config?.workflow, "redline_add");
  assert.equal((redlineAddReceptacle?.adapter_config?.request as any)?.targetKind, "receptacle");
  assert.match(redlineAddReceptacle?.success_criteria.join(" ") ?? "", /receptacle.*visible/is);
  const redlineAddLight = tasks.find((task) => task.task_id === "demo_redline_add_light");
  assert.equal(redlineAddLight?.adapter_config?.workflow, "redline_add");
  assert.equal((redlineAddLight?.adapter_config?.request as any)?.targetKind, "light");
  assert.match(redlineAddLight?.success_criteria.join(" ") ?? "", /light.*visible/is);
  const redlineAddMepAccessory = tasks.find((task) => task.task_id === "demo_redline_add_mep_accessory");
  assert.equal(redlineAddMepAccessory?.adapter_config?.workflow, "redline_add");
  assert.equal((redlineAddMepAccessory?.adapter_config?.request as any)?.targetKind, "mep_accessory");
  assert.match(redlineAddMepAccessory?.success_criteria.join(" ") ?? "", /MEP accessory.*visible/is);
  const redlineDelete = tasks.find((task) => task.task_id === "demo_redline_delete_text");
  assert.equal(redlineDelete?.adapter_config?.workflow, "redline_delete");
  assert.match(redlineDelete?.success_criteria.join(" ") ?? "", /dry-run.*applied.*no longer contains/is);
  const redlineDeleteTag = tasks.find((task) => task.task_id === "demo_redline_delete_tag");
  assert.equal(redlineDeleteTag?.adapter_config?.workflow, "redline_delete");
  assert.equal((redlineDeleteTag?.adapter_config?.request as any)?.targetKind, "tag");
  assert.match(redlineDeleteTag?.success_criteria.join(" ") ?? "", /disposable tag id.*dry-run.*applied/is);
  const redlineDeleteFamilyInstance = tasks.find((task) => task.task_id === "demo_redline_delete_family_instance");
  assert.equal(redlineDeleteFamilyInstance?.adapter_config?.workflow, "redline_delete");
  assert.equal((redlineDeleteFamilyInstance?.adapter_config?.request as any)?.targetKind, "family_instance");
  assert.match(redlineDeleteFamilyInstance?.success_criteria.join(" ") ?? "", /family instance id.*dry-run.*apply/is);
  const redlineDeleteReceptacle = tasks.find((task) => task.task_id === "demo_redline_delete_receptacle");
  assert.equal(redlineDeleteReceptacle?.adapter_config?.workflow, "redline_delete");
  assert.equal((redlineDeleteReceptacle?.adapter_config?.request as any)?.targetKind, "receptacle");
  assert.match(redlineDeleteReceptacle?.success_criteria.join(" ") ?? "", /receptacle.*dry-run.*apply/is);
  const redlineDeleteLight = tasks.find((task) => task.task_id === "demo_redline_delete_light");
  assert.equal(redlineDeleteLight?.adapter_config?.workflow, "redline_delete");
  assert.equal((redlineDeleteLight?.adapter_config?.request as any)?.targetKind, "light");
  assert.match(redlineDeleteLight?.success_criteria.join(" ") ?? "", /light.*dry-run.*apply/is);
  const redlineDeleteDuctRoute = tasks.find((task) => task.task_id === "demo_redline_delete_duct_route");
  assert.equal(redlineDeleteDuctRoute?.adapter_config?.workflow, "redline_delete");
  assert.equal((redlineDeleteDuctRoute?.adapter_config?.request as any)?.targetKind, "duct_route");
  assert.match(redlineDeleteDuctRoute?.success_criteria.join(" ") ?? "", /duct route.*created model ids.*delete/is);
  const redlineDeletePipeRoute = tasks.find((task) => task.task_id === "demo_redline_delete_pipe_route");
  assert.equal(redlineDeletePipeRoute?.adapter_config?.workflow, "redline_delete");
  assert.equal((redlineDeletePipeRoute?.adapter_config?.request as any)?.targetKind, "pipe_route");
  assert.match(redlineDeletePipeRoute?.success_criteria.join(" ") ?? "", /pipe route.*created model ids.*delete/is);
  const redlineDeleteMepAccessory = tasks.find((task) => task.task_id === "demo_redline_delete_mep_accessory");
  assert.equal(redlineDeleteMepAccessory?.adapter_config?.workflow, "redline_delete");
  assert.equal((redlineDeleteMepAccessory?.adapter_config?.request as any)?.targetKind, "manual_balancing_damper");
  assert.match(redlineDeleteMepAccessory?.success_criteria.join(" ") ?? "", /MEP accessory.*dry-run.*apply/is);
  const redlineMove = tasks.find((task) => task.task_id === "demo_redline_move_text");
  assert.equal(redlineMove?.adapter_config?.workflow, "redline_move");
  assert.match(redlineMove?.success_criteria.join(" ") ?? "", /dry-run.*applied.*model-space delta/is);
  const redlineMoveTag = tasks.find((task) => task.task_id === "demo_redline_move_tag");
  assert.equal(redlineMoveTag?.adapter_config?.workflow, "redline_move");
  assert.equal((redlineMoveTag?.adapter_config?.request as any)?.targetKind, "tag");
  assert.match(redlineMoveTag?.success_criteria.join(" ") ?? "", /disposable tag id.*model-space delta/is);
  const redlineMoveFamilyInstance = tasks.find((task) => task.task_id === "demo_redline_move_family_instance");
  assert.equal(redlineMoveFamilyInstance?.adapter_config?.workflow, "redline_move");
  assert.equal((redlineMoveFamilyInstance?.adapter_config?.request as any)?.targetKind, "family_instance");
  assert.match(redlineMoveFamilyInstance?.success_criteria.join(" ") ?? "", /family instance id.*model-space delta/is);
  const redlineMoveReceptacle = tasks.find((task) => task.task_id === "demo_redline_move_receptacle");
  assert.equal(redlineMoveReceptacle?.adapter_config?.workflow, "redline_move");
  assert.equal((redlineMoveReceptacle?.adapter_config?.request as any)?.targetKind, "receptacle");
  assert.match(redlineMoveReceptacle?.success_criteria.join(" ") ?? "", /receptacle.*model-space delta/is);
  const redlineMoveLight = tasks.find((task) => task.task_id === "demo_redline_move_light");
  assert.equal(redlineMoveLight?.adapter_config?.workflow, "redline_move");
  assert.equal((redlineMoveLight?.adapter_config?.request as any)?.targetKind, "light");
  assert.match(redlineMoveLight?.success_criteria.join(" ") ?? "", /light.*model-space delta/is);
  const redlineMoveMepAccessory = tasks.find((task) => task.task_id === "demo_redline_move_mep_accessory");
  assert.equal(redlineMoveMepAccessory?.adapter_config?.workflow, "redline_move");
  assert.equal((redlineMoveMepAccessory?.adapter_config?.request as any)?.targetKind, "manual_balancing_damper");
  assert.match(redlineMoveMepAccessory?.success_criteria.join(" ") ?? "", /MEP accessory.*model-space delta/is);
  const redlineMoveDuctRoute = tasks.find((task) => task.task_id === "demo_redline_move_duct_route");
  assert.equal(redlineMoveDuctRoute?.adapter_config?.workflow, "redline_move");
  assert.equal((redlineMoveDuctRoute?.adapter_config?.request as any)?.targetKind, "duct_route");
  assert.match(redlineMoveDuctRoute?.success_criteria.join(" ") ?? "", /duct route.*model-space movement vector/is);
  const redlineMovePipeRoute = tasks.find((task) => task.task_id === "demo_redline_move_pipe_route");
  assert.equal(redlineMovePipeRoute?.adapter_config?.workflow, "redline_move");
  assert.equal((redlineMovePipeRoute?.adapter_config?.request as any)?.targetKind, "pipe_route");
  assert.match(redlineMovePipeRoute?.success_criteria.join(" ") ?? "", /pipe route.*model-space movement vector/is);
  const redlineRotate = tasks.find((task) => task.task_id === "demo_redline_rotate_text");
  assert.equal(redlineRotate?.adapter_config?.workflow, "redline_rotate");
  assert.match(redlineRotate?.success_criteria.join(" ") ?? "", /dry-run.*applied.*visible-element inventory/is);
  const redlineTypeChange = tasks.find((task) => task.task_id === "demo_redline_type_change_device");
  assert.equal(redlineTypeChange?.adapter_config?.workflow, "redline_type_change");
  assert.match(redlineTypeChange?.success_criteria.join(" ") ?? "", /dry-run.*apply.*readback/is);
  const redlineDuctTypeChange = tasks.find((task) => task.task_id === "demo_redline_type_change_duct");
  assert.equal(redlineDuctTypeChange?.adapter_config?.workflow, "redline_type_change");
  assert.equal((redlineDuctTypeChange?.adapter_config?.request as any)?.category, "OST_DuctCurves");
  assert.match(redlineDuctTypeChange?.success_criteria.join(" ") ?? "", /rectangular.*round.*readback/is);
  const redlineMepAccessoryTypeChange = tasks.find((task) => task.task_id === "demo_redline_type_change_mep_accessory");
  assert.equal(redlineMepAccessoryTypeChange?.adapter_config?.workflow, "redline_type_change");
  assert.equal((redlineMepAccessoryTypeChange?.adapter_config?.request as any)?.category, "OST_DuctAccessory");
  assert.equal((redlineMepAccessoryTypeChange?.adapter_config?.request as any)?.sourceFamilyGrounding?.expectedFamilyName, "Manual Balancing Damper");
  assert.match(redlineMepAccessoryTypeChange?.success_criteria.join(" ") ?? "", /source accessory family\/type\/category/i);
  const redlineTextEditMepAccessory = tasks.find((task) => task.task_id === "demo_redline_text_edit_mep_accessory");
  assert.equal(redlineTextEditMepAccessory?.adapter_config?.workflow, "parameter_edit");
  assert.equal((redlineTextEditMepAccessory?.adapter_config?.request as any)?.targetKind, "mep_accessory");
  assert.equal((redlineTextEditMepAccessory?.adapter_config?.request as any)?.targetGrounding?.expectedCategory, "OST_DuctAccessory");
  assert.match(redlineTextEditMepAccessory?.success_criteria.join(" ") ?? "", /category.*family\/type/i);
  const mepRoute = tasks.find((task) => task.task_id === "demo_redline_mep_route");
  assert.equal(mepRoute?.adapter_config?.workflow, "redline_mep_route");
  assert.equal((mepRoute?.adapter_config?.request as any)?.apply, true);
  assert.equal((mepRoute?.adapter_config?.request as any)?.visualVerify, true);
  assert.match(mepRoute?.success_criteria.join(" ") ?? "", /created duct\/pipe element or fitting ids/i);
  const mepPipeRoute = tasks.find((task) => task.task_id === "demo_redline_mep_pipe_route");
  assert.equal(mepPipeRoute?.adapter_config?.workflow, "redline_mep_route");
  assert.equal((mepPipeRoute?.adapter_config?.request as any)?.kind, "pipe");
  assert.equal((mepPipeRoute?.adapter_config?.request as any)?.cleanupCreatedElements, true);
  assert.match(mepPipeRoute?.success_criteria.join(" ") ?? "", /created pipe route ids are proven in a cleanup dry-run and then deleted/i);
  const ductTapBranch = tasks.find((task) => task.task_id === "demo_redline_mep_duct_tap_branch");
  assert.equal(ductTapBranch?.adapter_config?.workflow, "redline_mep_tap_branch");
  assert.equal((ductTapBranch?.adapter_config?.request as any)?.kind, "duct");
  assert.equal((ductTapBranch?.adapter_config?.request as any)?.connectionMode, "tap");
  assert.equal((ductTapBranch?.adapter_config?.request as any)?.cleanupCreatedElements, true);
  assert.match(ductTapBranch?.success_criteria.join(" ") ?? "", /created branch duct ids and takeoff\/tap fitting ids/i);
  const pipeTapBranch = tasks.find((task) => task.task_id === "demo_redline_mep_pipe_tap_branch");
  assert.equal(pipeTapBranch?.adapter_config?.workflow, "redline_mep_tap_branch");
  assert.equal((pipeTapBranch?.adapter_config?.request as any)?.kind, "pipe");
  assert.equal((pipeTapBranch?.adapter_config?.request as any)?.branchNetworkWorkflow, true);
  assert.equal((pipeTapBranch?.adapter_config?.request as any)?.connectionMode, "tee");
  assert.equal((pipeTapBranch?.adapter_config?.request as any)?.expectedFitting, "tee");
  assert.equal((pipeTapBranch?.adapter_config?.request as any)?.mainElementId, undefined);
  assert.equal((pipeTapBranch?.adapter_config?.request as any)?.mainPoints.length, 2);
  assert.equal((pipeTapBranch?.adapter_config?.request as any)?.branches[0]?.points.length, 2);
  assert.equal((pipeTapBranch?.adapter_config?.request as any)?.cleanupCreatedElements, true);
  assert.match(pipeTapBranch?.success_criteria.join(" ") ?? "", /created branch pipe ids, and tee fitting ids/i);
  const ductReroute = tasks.find((task) => task.task_id === "demo_redline_mep_duct_reroute");
  assert.equal(ductReroute?.adapter_config?.workflow, "redline_mep_reroute");
  assert.equal((ductReroute?.adapter_config?.request as any)?.kind, "duct");
  assert.equal((ductReroute?.adapter_config?.request as any)?.operation, "reroute_offset");
  assert.equal((ductReroute?.adapter_config?.request as any)?.cleanupCreatedElements, true);
  assert.match(ductReroute?.success_criteria.join(" ") ?? "", /replacement duct segment ids and elbow fitting ids/i);
  const pipeReroute = tasks.find((task) => task.task_id === "demo_redline_mep_pipe_reroute");
  assert.equal(pipeReroute?.adapter_config?.workflow, "redline_mep_reroute");
  assert.equal((pipeReroute?.adapter_config?.request as any)?.kind, "pipe");
  assert.equal((pipeReroute?.adapter_config?.request as any)?.operation, "reroute_offset");
  assert.equal((pipeReroute?.adapter_config?.request as any)?.cleanupCreatedElements, true);
  assert.match(pipeReroute?.success_criteria.join(" ") ?? "", /replacement pipe segment ids and elbow fitting ids/i);
  const ductSizeTransition = tasks.find((task) => task.task_id === "demo_redline_mep_duct_size_transition");
  assert.equal(ductSizeTransition?.adapter_config?.workflow, "redline_mep_size_transition");
  assert.equal((ductSizeTransition?.adapter_config?.request as any)?.kind, "duct");
  assert.equal((ductSizeTransition?.adapter_config?.request as any)?.cleanupCreatedElements, true);
  assert.match(ductSizeTransition?.success_criteria.join(" ") ?? "", /upstream\/downstream duct sizes are read back/i);
  const pipeSizeTransition = tasks.find((task) => task.task_id === "demo_redline_mep_pipe_size_transition");
  assert.equal(pipeSizeTransition?.adapter_config?.workflow, "redline_mep_size_transition");
  assert.equal((pipeSizeTransition?.adapter_config?.request as any)?.kind, "pipe");
  assert.equal((pipeSizeTransition?.adapter_config?.request as any)?.expectedFitting, "transition");
  assert.equal((pipeSizeTransition?.adapter_config?.request as any)?.hostElementId, undefined);
  assert.equal((pipeSizeTransition?.adapter_config?.request as any)?.createHostRoute?.points.length, 2);
  assert.equal((pipeSizeTransition?.adapter_config?.request as any)?.cleanupCreatedElements, true);
  assert.match(pipeSizeTransition?.success_criteria.join(" ") ?? "", /upstream\/downstream pipe sizes are read back/i);
  const documentation = tasks.find((task) => task.task_id === "demo_documentation_primitives");
  assert.equal(documentation?.adapter_config?.workflow, "documentation_primitives");
  assert.match(documentation?.success_criteria.join(" ") ?? "", /schedule.*configure-schedule.*sheet.*create-view.*visibility.*annotation/is);
  assert.equal((documentation?.adapter_config?.request as any)?.templateCategoryVisibility?.lineWeight, 5);
  assert.match((documentation?.adapter_config?.request as any)?.cadLink?.sourcePath ?? "", /\.dwg$/i);
  const modelEdit = tasks.find((task) => task.task_id === "demo_model_edit_primitives");
  assert.equal(modelEdit?.adapter_config?.workflow, "model_edit_primitives");
  assert.match(modelEdit?.success_criteria.join(" ") ?? "", /create.*move.*delete.*link-revit/is);
  assert.match(modelEdit?.grader_notes.join(" ") ?? "", /RVT linking primitives/i);
});
