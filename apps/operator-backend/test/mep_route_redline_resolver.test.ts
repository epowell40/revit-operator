import assert from "node:assert/strict";
import test from "node:test";
import {
  __testOnlyClassifyRedlineGeometry,
  resolveMepRouteRedline,
  type ResolveMepRouteRedlineRequest
} from "../src/deterministic/mep_route_redline.js";
import {
  __testOnlyBuildRedlineRouteCandidates,
  type RedlineAnalyzeResponse
} from "../src/redline/redline_analyzer.js";

function baseAnalysis(overrides: Partial<RedlineAnalyzeResponse> = {}): RedlineAnalyzeResponse {
  return {
    ok: true,
    file_path: "artifacts/uploads/marked.pdf",
    full_path: "C:/Users/User/source/repos/RevitOperator/artifacts/uploads/marked.pdf",
    kind: "pdf",
    bytes: 1234,
    page_count: 1,
    likely_sheet: true,
    primary_sheet_number: "M104",
    sheet_candidates: [{ sheet_number: "M104", score: 10, source: "text", hit_count: 1 }],
    image_meta: { width: 1000, height: 1000 },
    mark_regions: [
      {
        index: 1,
        source: "pdf_annotation",
        x: 500,
        y: 600,
        w: 100,
        h: 5,
        area: 500,
        annotation_subtype: "PolyLine",
        annotation_contents: "12x10 supply duct",
        annotation_is_red_like: true,
        annotation_page: 1,
        annotation_index: 1,
        annotation_id: "109R",
        annotation_box_norm: { minX: 0.4, minY: 0.62, maxX: 0.5, maxY: 0.625 },
        annotation_vertices_norm: [{ x: 0.4, y: 0.62 }, { x: 0.5, y: 0.62 }],
        annotation_related_indices: [2],
        annotation_related_text: "12x10 supply duct"
      }
    ],
    pdf_annotations: [
      {
        page: 1,
        annotation_index: 1,
        id: "109R",
        subtype: "PolyLine",
        color: "rgb(239,68,68)",
        is_red_like: true,
        box_norm: { minX: 0.4, minY: 0.62, maxX: 0.5, maxY: 0.625 },
        vertices_norm: [{ x: 0.4, y: 0.62 }, { x: 0.5, y: 0.62 }],
        related_annotation_indices: [2],
        related_text: "12x10 supply duct"
      },
      {
        page: 1,
        annotation_index: 2,
        id: "111R",
        subtype: "FreeText",
        is_red_like: false,
        contents: "12x10 supply duct",
        box_norm: { minX: 0.39, minY: 0.58, maxX: 0.55, maxY: 0.67 },
        related_annotation_indices: [1]
      }
    ],
    orientation_hints: [],
    suggested_revit_calls: [],
    ...overrides
  };
}

function sheetDetailToolResult() {
  return {
    action_id: "sheet",
    method: "POST" as const,
    path: "/revit/sheets",
    status: "done" as const,
    result_json: {
      status: "Ok",
      action: "detail",
      sheetNumber: "M104",
      sheetOutline: { minU: 0, minV: 0, maxU: 10, maxV: 10 },
      placedViews: [{ viewId: 1363433, name: "L4 - HVAC", viewType: "FloorPlan", scale: 96 }],
      viewportGeometry: [{ viewportId: 1411539, viewId: 1363433, box: { minU: 0, minV: 0, maxU: 10, maxV: 10 }, rotation: "none" }]
    }
  };
}

function frameWithMappingToolResult() {
  return {
    action_id: "frame",
    method: "POST" as const,
    path: "/revit/export-view-frame",
    status: "done" as const,
    result_json: {
      frameId: "frame-1",
      viewId: 1363433,
      widthPx: 2200,
      heightPx: 1223,
      path: "C:/Users/User/source/repos/RevitOperator/artifacts/captures/frame.jpg",
      mapping: {
        mode: "2d_affine",
        topLeftXyz: [0, 100, 0],
        topRightXyz: [100, 100, 0],
        bottomLeftXyz: [0, 0, 0],
        pixelAxes: { x: "right", y: "down" },
        modelUnits: "feet"
      }
    }
  };
}

function contextToolResult() {
  return {
    action_id: "context",
    method: "POST" as const,
    path: "/revit/resolve-mep-routing-context",
    status: "done" as const,
    result_json: {
      status: "Ok",
      view: { id: 1363433, name: "L4", type: "FloorPlan" },
      level: { id: 1362791, name: "L4", elevation: 32.1667 },
      recommendedElevation: { zFt: 38.8333, mode: "between_levels_midpoint", confidence: "low" }
    }
  };
}

function visibleUnit405ToolResult(overrides: Record<string, unknown> = {}) {
  return {
    action_id: "visible",
    method: "POST" as const,
    path: "/revit/export-visible-elements",
    status: "done" as const,
    result_json: {
      frameId: "frame-1",
      viewId: 1363433,
      count: 4,
      items: [
        {
          elementId: 1411041,
          category: "Spaces",
          builtInCategory: "OST_MEPSpaces",
          name: "Live/Work Loft Unit 405",
          space: { id: 1411041, number: "405", name: "Live/Work Loft Unit" },
          associatedSpatial: { id: 1411041, number: "405", name: "Live/Work Loft Unit", type: "Space" },
          anchor: { image: { normalizedX: 0.5, normalizedY: 0.66, insideFrame: true } },
          bbox: { image: { normalizedMinX: 0.22, normalizedMinY: 0.45, normalizedMaxX: 0.78, normalizedMaxY: 0.92, intersectsFrame: true } }
        },
        {
          elementId: 7605,
          category: "Generic Annotations",
          builtInCategory: "OST_GenericAnnotation",
          visibleText: "Live/Work Loft Unit",
          anchor: { image: { normalizedX: 0.5, normalizedY: 0.68, insideFrame: true } }
        },
        {
          elementId: 7606,
          category: "Generic Annotations",
          builtInCategory: "OST_GenericAnnotation",
          visibleText: "405",
          anchor: { image: { normalizedX: 0.5, normalizedY: 0.78, insideFrame: true } }
        },
        {
          elementId: 5001,
          category: "Plumbing Fixtures",
          builtInCategory: "OST_PlumbingFixtures",
          associatedSpatial: { number: "405", name: "Live/Work Loft Unit", type: "Space" },
          anchor: { image: { normalizedX: 0.5, normalizedY: 0.28, insideFrame: true } }
        }
      ],
      ...overrides
    }
  };
}

function visibleUnit405SpaceOnlyToolResult() {
  return visibleUnit405ToolResult({
    count: 1,
    items: [
      {
        elementId: 1411041,
        category: "Spaces",
        builtInCategory: "OST_MEPSpaces",
        categoryToken: "OST_MEPSpaces",
        name: "Live/Work Loft Unit 405",
        space: { id: 1411041, number: "405", name: "Live/Work Loft Unit" },
        associatedSpatial: { id: 1411041, number: "405", name: "Live/Work Loft Unit", type: "Space" },
        anchor: { image: { normalizedX: 0.523, normalizedY: 0.7186, insideFrame: true } },
        bbox: { image: { normalizedMinX: 0.4694, normalizedMinY: 0.5843, normalizedMaxX: 0.5766, normalizedMaxY: 0.8527, intersectsFrame: true } }
      }
    ]
  });
}

function request(overrides: Partial<ResolveMepRouteRedlineRequest> = {}): ResolveMepRouteRedlineRequest {
  return {
    user_text: "pick up redline from marked.pdf for Live/Work Loft Unit 405",
    file_path: "artifacts/uploads/marked.pdf",
    analysis: baseAnalysis(),
    tool_results: [],
    ...overrides
  };
}

function targetPathAnalysis(): RedlineAnalyzeResponse {
  return baseAnalysis({
    mark_regions: [
      {
        index: 1,
        source: "pdf_annotation",
        x: 500,
        y: 600,
        w: 180,
        h: 20,
        area: 3600,
        annotation_subtype: "PolyLine",
        annotation_is_red_like: true,
        annotation_page: 1,
        annotation_index: 1,
        annotation_id: "route-1",
        annotation_box_norm: { minX: 0.4, minY: 0.72, maxX: 0.58, maxY: 0.74 },
        annotation_vertices_norm: [{ x: 0.4, y: 0.73 }, { x: 0.58, y: 0.73 }]
      }
    ],
    pdf_annotations: [
      {
        page: 1,
        annotation_index: 1,
        id: "route-1",
        subtype: "PolyLine",
        color: "rgb(239,68,68)",
        is_red_like: true,
        box_norm: { minX: 0.4, minY: 0.72, maxX: 0.58, maxY: 0.74 },
        vertices_norm: [{ x: 0.4, y: 0.73 }, { x: 0.58, y: 0.73 }]
      },
      {
        page: 1,
        annotation_index: 2,
        id: "111R",
        subtype: "FreeText",
        is_red_like: false,
        contents: "12x10 supply duct",
        box_norm: { minX: 0.39, minY: 0.58, maxX: 0.55, maxY: 0.67 },
        related_annotation_indices: []
      }
    ]
  });
}

function targetPathAnalysisWithLabel(label: string): RedlineAnalyzeResponse {
  const analysis = targetPathAnalysis();
  return {
    ...analysis,
    mark_regions: (analysis.mark_regions ?? []).map(region => ({
      ...region,
      annotation_contents: label,
      annotation_related_text: label
    })),
    pdf_annotations: (analysis.pdf_annotations ?? []).map(annotation => {
      if (annotation.id === "route-1") return { ...annotation, related_text: label };
      if (annotation.id === "111R") return { ...annotation, contents: label };
      return annotation;
    })
  };
}

function targetThreePointPathAnalysis(): RedlineAnalyzeResponse {
  const analysis = targetPathAnalysis();
  const vertices = [{ x: 0.4, y: 0.73 }, { x: 0.49, y: 0.73 }, { x: 0.58, y: 0.73 }];
  return {
    ...analysis,
    mark_regions: (analysis.mark_regions ?? []).map(region => ({
      ...region,
      annotation_vertices_norm: vertices
    })),
    route_candidates: [
      {
        candidate_index: 1,
        label_text: "12x10 supply duct",
        mep_kind_hint: "duct",
        size_text: "12x10",
        target_annotation_indices: [1],
        label_annotation_indices: [2],
        vertices_norm: vertices,
        box_norm: { minX: 0.39, minY: 0.58, maxX: 0.58, maxY: 0.74 },
        confidence: 0.95,
        reason: "Three-point duct route vector is spatially associated with nearby MEP callout text."
      }
    ],
    pdf_annotations: (analysis.pdf_annotations ?? []).map(annotation => annotation.id === "route-1"
      ? { ...annotation, vertices_norm: vertices }
      : annotation)
  };
}

function targetPathAnalysisWithPreview(): RedlineAnalyzeResponse {
  return {
    ...targetPathAnalysis(),
    vision_artifacts: {
      preview_image_path: "artifacts/redline/marked_page_01.png"
    }
  };
}

function targetPathAnalysisWithRouteCrop(): RedlineAnalyzeResponse {
  return baseAnalysis({
    mark_regions: [
      {
        index: 1,
        source: "pdf_annotation",
        x: 300,
        y: 400,
        w: 400,
        h: 8,
        area: 3200,
        annotation_subtype: "PolyLine",
        annotation_is_red_like: true,
        annotation_page: 1,
        annotation_index: 1,
        annotation_id: "route-north-1",
        annotation_box_norm: { minX: 0.3, minY: 0.397, maxX: 0.7, maxY: 0.403 },
        annotation_vertices_norm: [{ x: 0.3, y: 0.4 }, { x: 0.7, y: 0.4 }],
        annotation_related_indices: [2],
        annotation_related_text: "12x10 supply duct"
      }
    ],
    route_candidates: [
      {
        candidate_index: 1,
        label_text: "12x10 supply duct",
        mep_kind_hint: "duct",
        size_text: "12x10",
        target_annotation_indices: [1],
        label_annotation_indices: [2],
        vertices_norm: [{ x: 0.3, y: 0.4 }, { x: 0.7, y: 0.4 }],
        box_norm: { minX: 0.2, minY: 0.2, maxX: 0.8, maxY: 0.8 },
        alignment_image_path: "artifacts/redline/route_candidate_01.png",
        alignment_crop_norm: { minX: 0.2, minY: 0.2, maxX: 0.8, maxY: 0.8 },
        confidence: 0.95,
        reason: "Separate red vector line is spatially associated with nearby MEP callout text."
      }
    ],
    pdf_annotations: [
      {
        page: 1,
        annotation_index: 1,
        id: "route-north-1",
        subtype: "PolyLine",
        color: "rgb(239,68,68)",
        is_red_like: true,
        box_norm: { minX: 0.3, minY: 0.397, maxX: 0.7, maxY: 0.403 },
        vertices_norm: [{ x: 0.3, y: 0.4 }, { x: 0.7, y: 0.4 }],
        related_annotation_indices: [2],
        related_text: "12x10 supply duct"
      },
      {
        page: 1,
        annotation_index: 2,
        id: "text-south-1",
        subtype: "FreeText",
        is_red_like: false,
        contents: "12x10 supply duct",
        box_norm: { minX: 0.25, minY: 0.62, maxX: 0.75, maxY: 0.76 },
        related_annotation_indices: [1]
      }
    ],
    vision_artifacts: {
      preview_image_path: "artifacts/redline/marked_page_01.png"
    }
  });
}

function upperFixtureBandAnalysis(): RedlineAnalyzeResponse {
  return baseAnalysis({
    mark_regions: [
      {
        index: 1,
        source: "pdf_annotation",
        x: 409,
        y: 687,
        w: 40,
        h: 4,
        area: 160,
        annotation_subtype: "PolyLine",
        annotation_is_red_like: true,
        annotation_page: 1,
        annotation_index: 1,
        annotation_id: "route-upper-fixture-band",
        annotation_box_norm: { minX: 0.4086, minY: 0.684, maxX: 0.4489, maxY: 0.69 },
        annotation_vertices_norm: [{ x: 0.4086, y: 0.6868 }, { x: 0.4489, y: 0.6868 }],
        annotation_related_indices: [2],
        annotation_related_text: "12x10 supply duct"
      }
    ],
    pdf_annotations: [
      {
        page: 1,
        annotation_index: 1,
        id: "route-upper-fixture-band",
        subtype: "PolyLine",
        color: "rgb(239,68,68)",
        is_red_like: true,
        box_norm: { minX: 0.4086, minY: 0.684, maxX: 0.4489, maxY: 0.69 },
        vertices_norm: [{ x: 0.4086, y: 0.6868 }, { x: 0.4489, y: 0.6868 }],
        related_annotation_indices: [2],
        related_text: "12x10 supply duct"
      },
      {
        page: 1,
        annotation_index: 2,
        id: "text-1",
        subtype: "FreeText",
        is_red_like: false,
        contents: "12x10 supply duct",
        box_norm: { minX: 0.25, minY: 0.62, maxX: 0.75, maxY: 0.76 },
        related_annotation_indices: [1]
      }
    ]
  });
}

function kitchenBandRouteAnalysis(): RedlineAnalyzeResponse {
  return {
    ...targetPathAnalysisWithRouteCrop(),
    mark_regions: [
      {
        index: 1,
        source: "pdf_annotation",
        x: 300,
        y: 200,
        w: 400,
        h: 8,
        area: 3200,
        annotation_subtype: "PolyLine",
        annotation_is_red_like: true,
        annotation_page: 1,
        annotation_index: 1,
        annotation_id: "route-kitchen-band",
        annotation_box_norm: { minX: 0.3, minY: 0.197, maxX: 0.7, maxY: 0.203 },
        annotation_vertices_norm: [{ x: 0.3, y: 0.2 }, { x: 0.7, y: 0.2 }],
        annotation_related_indices: [2],
        annotation_related_text: "12x10 supply duct"
      }
    ],
    route_candidates: [
      {
        candidate_index: 1,
        label_text: "12x10 supply duct",
        mep_kind_hint: "duct",
        size_text: "12x10",
        target_annotation_indices: [1],
        label_annotation_indices: [2],
        vertices_norm: [{ x: 0.3, y: 0.2 }, { x: 0.7, y: 0.2 }],
        box_norm: { minX: 0.2, minY: 0.1, maxX: 0.8, maxY: 0.76 },
        alignment_image_path: "artifacts/redline/route_candidate_01.png",
        alignment_crop_norm: { minX: 0.2, minY: 0.1, maxX: 0.8, maxY: 0.76 },
        confidence: 0.95,
        reason: "Separate red vector line is spatially associated with nearby MEP callout text."
      }
    ],
    pdf_annotations: [
      {
        page: 1,
        annotation_index: 1,
        id: "route-kitchen-band",
        subtype: "PolyLine",
        color: "rgb(239,68,68)",
        is_red_like: true,
        box_norm: { minX: 0.3, minY: 0.197, maxX: 0.7, maxY: 0.203 },
        vertices_norm: [{ x: 0.3, y: 0.2 }, { x: 0.7, y: 0.2 }],
        related_annotation_indices: [2],
        related_text: "12x10 supply duct"
      },
      {
        page: 1,
        annotation_index: 2,
        id: "text-south-1",
        subtype: "FreeText",
        is_red_like: false,
        contents: "12x10 supply duct",
        box_norm: { minX: 0.25, minY: 0.62, maxX: 0.75, maxY: 0.76 },
        related_annotation_indices: [1]
      }
    ]
  };
}

function underlineAnalysis(): RedlineAnalyzeResponse {
  return baseAnalysis({
    mark_regions: [
      {
        index: 1,
        source: "pdf_annotation",
        x: 390,
        y: 622,
        w: 160,
        h: 5,
        area: 800,
        annotation_subtype: "PolyLine",
        annotation_contents: "12x10 supply duct",
        annotation_is_red_like: true,
        annotation_page: 1,
        annotation_index: 1,
        annotation_id: "underline-1",
        annotation_box_norm: { minX: 0.39, minY: 0.665, maxX: 0.55, maxY: 0.67 },
        annotation_vertices_norm: [{ x: 0.39, y: 0.667 }, { x: 0.55, y: 0.667 }],
        annotation_related_indices: [2],
        annotation_related_text: "12x10 supply duct"
      }
    ],
    pdf_annotations: [
      {
        page: 1,
        annotation_index: 1,
        id: "underline-1",
        subtype: "PolyLine",
        color: "rgb(239,68,68)",
        is_red_like: true,
        box_norm: { minX: 0.39, minY: 0.665, maxX: 0.55, maxY: 0.67 },
        vertices_norm: [{ x: 0.39, y: 0.667 }, { x: 0.55, y: 0.667 }],
        related_annotation_indices: [2],
        related_text: "12x10 supply duct"
      },
      {
        page: 1,
        annotation_index: 2,
        id: "111R",
        subtype: "FreeText",
        is_red_like: false,
        contents: "12x10 supply duct",
        box_norm: { minX: 0.39, minY: 0.58, maxX: 0.55, maxY: 0.67 },
        related_annotation_indices: [1]
      }
    ]
  });
}

function pipePathAnalysis(): RedlineAnalyzeResponse {
  return baseAnalysis({
    mark_regions: [
      {
        index: 1,
        source: "pdf_annotation",
        x: 420,
        y: 630,
        w: 140,
        h: 8,
        area: 1120,
        annotation_subtype: "PolyLine",
        annotation_is_red_like: true,
        annotation_page: 1,
        annotation_index: 1,
        annotation_id: "pipe-route-1",
        annotation_box_norm: { minX: 0.42, minY: 0.63, maxX: 0.56, maxY: 0.638 },
        annotation_vertices_norm: [{ x: 0.42, y: 0.634 }, { x: 0.56, y: 0.634 }],
        annotation_related_indices: [2],
        annotation_related_text: "6-inch water pipe"
      }
    ],
    pdf_annotations: [
      {
        page: 1,
        annotation_index: 1,
        id: "pipe-route-1",
        subtype: "PolyLine",
        color: "rgb(239,68,68)",
        is_red_like: true,
        box_norm: { minX: 0.42, minY: 0.63, maxX: 0.56, maxY: 0.638 },
        vertices_norm: [{ x: 0.42, y: 0.634 }, { x: 0.56, y: 0.634 }],
        related_annotation_indices: [2],
        related_text: "6-inch water pipe"
      },
      {
        page: 1,
        annotation_index: 2,
        id: "pipe-text-1",
        subtype: "FreeText",
        is_red_like: false,
        contents: "6-inch water pipe",
        box_norm: { minX: 0.39, minY: 0.58, maxX: 0.57, maxY: 0.67 },
        related_annotation_indices: [1]
      }
    ]
  });
}

function mixedPipeAndDuctRouteCandidateAnalysis(): RedlineAnalyzeResponse {
  return baseAnalysis({
    mark_regions: [
      {
        index: 1,
        source: "pdf_annotation",
        x: 300,
        y: 700,
        w: 220,
        h: 120,
        area: 26400,
        annotation_subtype: "PolyLine",
        annotation_is_red_like: true,
        annotation_page: 1,
        annotation_index: 1,
        annotation_id: "duct-route-high-confidence",
        annotation_box_norm: { minX: 0.3, minY: 0.7, maxX: 0.52, maxY: 0.82 },
        annotation_vertices_norm: [{ x: 0.3, y: 0.7 }, { x: 0.52, y: 0.7 }, { x: 0.52, y: 0.82 }],
        annotation_related_indices: [2],
        annotation_related_text: "12x10 supply duct"
      },
      {
        index: 2,
        source: "pdf_annotation",
        x: 420,
        y: 630,
        w: 140,
        h: 8,
        area: 1120,
        annotation_subtype: "PolyLine",
        annotation_is_red_like: true,
        annotation_page: 1,
        annotation_index: 3,
        annotation_id: "pipe-route-lower-confidence",
        annotation_box_norm: { minX: 0.42, minY: 0.63, maxX: 0.56, maxY: 0.638 },
        annotation_vertices_norm: [{ x: 0.42, y: 0.634 }, { x: 0.56, y: 0.634 }],
        annotation_related_indices: [4],
        annotation_related_text: "6-inch water pipe"
      }
    ],
    route_candidates: [
      {
        candidate_index: 1,
        label_text: "12x10 supply duct",
        mep_kind_hint: "duct",
        size_text: "12x10",
        target_annotation_indices: [1],
        label_annotation_indices: [2],
        vertices_norm: [{ x: 0.3, y: 0.7 }, { x: 0.52, y: 0.7 }, { x: 0.52, y: 0.82 }],
        box_norm: { minX: 0.3, minY: 0.58, maxX: 0.55, maxY: 0.82 },
        confidence: 0.94,
        reason: "Duct route vector is spatially associated with nearby MEP callout text."
      },
      {
        candidate_index: 2,
        label_text: "6-inch water pipe",
        mep_kind_hint: "pipe",
        size_text: "6-inch",
        target_annotation_indices: [3],
        label_annotation_indices: [4],
        vertices_norm: [{ x: 0.42, y: 0.634 }, { x: 0.56, y: 0.634 }],
        box_norm: { minX: 0.39, minY: 0.58, maxX: 0.57, maxY: 0.67 },
        confidence: 0.74,
        reason: "Pipe route vector is spatially associated with nearby MEP callout text."
      }
    ],
    pdf_annotations: [
      {
        page: 1,
        annotation_index: 1,
        id: "duct-route-high-confidence",
        subtype: "PolyLine",
        color: "rgb(239,68,68)",
        is_red_like: true,
        box_norm: { minX: 0.3, minY: 0.7, maxX: 0.52, maxY: 0.82 },
        vertices_norm: [{ x: 0.3, y: 0.7 }, { x: 0.52, y: 0.7 }, { x: 0.52, y: 0.82 }],
        related_annotation_indices: [2],
        related_text: "12x10 supply duct"
      },
      {
        page: 1,
        annotation_index: 2,
        id: "duct-label",
        subtype: "FreeText",
        is_red_like: false,
        contents: "12x10 supply duct",
        box_norm: { minX: 0.39, minY: 0.58, maxX: 0.55, maxY: 0.67 },
        related_annotation_indices: [1]
      },
      {
        page: 1,
        annotation_index: 3,
        id: "pipe-route-lower-confidence",
        subtype: "PolyLine",
        color: "rgb(239,68,68)",
        is_red_like: true,
        box_norm: { minX: 0.42, minY: 0.63, maxX: 0.56, maxY: 0.638 },
        vertices_norm: [{ x: 0.42, y: 0.634 }, { x: 0.56, y: 0.634 }],
        related_annotation_indices: [4],
        related_text: "6-inch water pipe"
      },
      {
        page: 1,
        annotation_index: 4,
        id: "pipe-label",
        subtype: "FreeText",
        is_red_like: false,
        contents: "6-inch water pipe",
        box_norm: { minX: 0.39, minY: 0.58, maxX: 0.57, maxY: 0.67 },
        related_annotation_indices: [3]
      }
    ]
  });
}

function competingRouteCandidateAnalysis(): RedlineAnalyzeResponse {
  return baseAnalysis({
    mark_regions: [
      {
        index: 1,
        source: "pdf_annotation",
        x: 390,
        y: 665,
        w: 160,
        h: 5,
        area: 800,
        annotation_subtype: "PolyLine",
        annotation_is_red_like: true,
        annotation_page: 1,
        annotation_index: 1,
        annotation_id: "underline-1",
        annotation_box_norm: { minX: 0.39, minY: 0.665, maxX: 0.55, maxY: 0.67 },
        annotation_vertices_norm: [{ x: 0.39, y: 0.667 }, { x: 0.55, y: 0.667 }],
        annotation_related_indices: [2],
        annotation_related_text: "12x10 supply duct"
      },
      {
        index: 2,
        source: "pdf_annotation",
        x: 300,
        y: 800,
        w: 200,
        h: 100,
        area: 20000,
        annotation_subtype: "PolyLine",
        annotation_is_red_like: true,
        annotation_page: 1,
        annotation_index: 3,
        annotation_id: "route-actual",
        annotation_box_norm: { minX: 0.3, minY: 0.8, maxX: 0.5, maxY: 0.9 },
        annotation_vertices_norm: [{ x: 0.3, y: 0.8 }, { x: 0.5, y: 0.8 }, { x: 0.5, y: 0.9 }],
        annotation_related_indices: [2],
        annotation_related_text: "12x10 supply duct"
      }
    ],
    route_candidates: [
      {
        candidate_index: 1,
        label_text: "12x10 supply duct",
        mep_kind_hint: "duct",
        size_text: "12x10",
        target_annotation_indices: [3],
        label_annotation_indices: [2],
        vertices_norm: [{ x: 0.3, y: 0.8 }, { x: 0.5, y: 0.8 }, { x: 0.5, y: 0.9 }],
        box_norm: { minX: 0.3, minY: 0.58, maxX: 0.55, maxY: 0.9 },
        alignment_image_path: "artifacts/redline/route_candidate_01.png",
        confidence: 0.91,
        reason: "Route vector is spatially associated with nearby MEP callout text; the text labels the route geometry."
      }
    ],
    pdf_annotations: [
      {
        page: 1,
        annotation_index: 1,
        id: "underline-1",
        subtype: "PolyLine",
        color: "rgb(239,68,68)",
        is_red_like: true,
        box_norm: { minX: 0.39, minY: 0.665, maxX: 0.55, maxY: 0.67 },
        vertices_norm: [{ x: 0.39, y: 0.667 }, { x: 0.55, y: 0.667 }],
        related_annotation_indices: [2],
        related_text: "12x10 supply duct"
      },
      {
        page: 1,
        annotation_index: 2,
        id: "text-1",
        subtype: "FreeText",
        is_red_like: false,
        contents: "12x10 supply duct",
        box_norm: { minX: 0.39, minY: 0.58, maxX: 0.55, maxY: 0.67 },
        related_annotation_indices: [1, 3]
      },
      {
        page: 1,
        annotation_index: 3,
        id: "route-actual",
        subtype: "PolyLine",
        color: "rgb(239,68,68)",
        is_red_like: true,
        box_norm: { minX: 0.3, minY: 0.8, maxX: 0.5, maxY: 0.9 },
        vertices_norm: [{ x: 0.3, y: 0.8 }, { x: 0.5, y: 0.8 }, { x: 0.5, y: 0.9 }],
        related_annotation_indices: [2],
        related_text: "12x10 supply duct"
      }
    ]
  });
}

test("MEP route redline resolver starts with sheet detail", async () => {
  const response = await resolveMepRouteRedline(request());

  assert.equal(response.handled, true);
  assert.equal(response.next_action?.path, "/revit/sheets");
  const body = response.next_action?.body as any;
  assert.equal(body.sheetNumber, "M104");
  assert.equal(body.includeViewportGeometry, true);
  assert.equal(response.task?.mep.size, "12x10");
  assert.equal(response.task?.mep.system_type, "Supply Air");
  assert.equal(response.task?.attachment?.page, 1);
  assert.equal(response.task?.redline.pdf_annotations?.length, 2);
  assert.equal(response.task?.redline.regions[0]?.annotation_id, "109R");
  assert.deepEqual(response.task?.redline.regions[0]?.annotation_related_indices, [2]);
  assert.match(response.task?.redline.regions[0]?.annotation_related_text ?? "", /12x10 supply/i);
  assert.equal(response.task?.redline.geometry_classification?.has_target_path, true);
  assert.equal(response.task?.redline.geometry_classification?.callout_only, false);
});

test("MEP route redline resolver blocks tap and takeoff edits before free route planning", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: targetPathAnalysisWithLabel("Add top tap off existing 12x10 supply duct for new branch"),
    user_text: "Pick up the attached MEP redline from marked.pdf."
  }));

  assert.equal(response.handled, true);
  assert.equal(response.ok, false);
  assert.equal(response.next_action, undefined);
  assert.match(response.blocker ?? "", /tap\/branch\/takeoff edit/i);
  assert.match(response.blocker ?? "", /main\/host element id/i);
  assert.equal(response.task?.status, "blocked");
  assert.equal(response.task?.warnings.some(w => /tap_branch/.test(w)), true);
});

test("MEP route redline resolver dry-runs verified duct tap evidence instead of free routing", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: targetPathAnalysisWithLabel("Add top tap off existing 12x10 supply duct for new branch"),
    user_text: "Pick up the attached MEP redline from marked.pdf.",
    verified_mep_tap_branch: {
      kind: "duct",
      viewId: 1363433,
      visualViewId: 1363433,
      mainElementId: 1542001,
      projectedTapPoint: { x: 82, y: -45, z: 43 },
      branchPoints: [{ x: 82, y: -45, z: 43 }, { x: 88, y: -45, z: 43 }],
      ductSize: "8x8",
      systemType: "Supply Air",
      levelName: "L4",
      connectionMode: "tap",
      expectedFitting: "takeoff"
    }
  }));

  assert.equal(response.handled, true);
  assert.equal(response.ok, true);
  assert.equal(response.next_action?.path, "/revit/connect-mep-branch");
  const body = response.next_action?.body as any;
  assert.equal(body.operation, "tap_branch");
  assert.equal(body.kind, "duct");
  assert.equal(body.mainElementId, 1542001);
  assert.deepEqual(body.projectedTapPoint, { x: 82, y: -45, z: 43 });
  assert.deepEqual(body.branchPoints, [{ x: 82, y: -45, z: 43 }, { x: 88, y: -45, z: 43 }]);
  assert.equal(body.ductSize, "8x8");
  assert.equal(body.connectionMode, "tap");
  assert.equal(body.expectedFitting, "takeoff");
  assert.equal(body.apply, false);
  assert.equal(body.verifyConnectorNetwork, true);
  assert.equal(body.visualVerify, false);
  assert.equal(body.cleanupCreatedElements, false);
  assert.match(response.assistant_message, /dry-run/);
});

test("MEP route redline resolver accepts verified pipe tap evidence from context", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: targetPathAnalysisWithLabel("Tee a 1 inch branch off existing 2 inch pipe main here"),
    user_text: "Pick up the attached plumbing redline from marked.pdf.",
    context: {
      verifiedMepTapBranch: {
        kind: "pipe",
        viewId: 1363433,
        visualViewId: 1363433,
        mainElementId: 1642001,
        projectedTapPoint: { x: 12, y: 14 },
        branchPoints: [{ x: 12, y: 14 }, { x: 12, y: 19 }],
        pipeSize: "1 inch",
        systemType: "Domestic Cold Water",
        connectionMode: "tee",
        expectedFitting: "tee",
        orientation: "top"
      }
    }
  }));

  assert.equal(response.ok, true);
  assert.equal(response.next_action?.path, "/revit/connect-mep-branch");
  const body = response.next_action?.body as any;
  assert.equal(body.kind, "pipe");
  assert.equal(body.mainElementId, 1642001);
  assert.deepEqual(body.projectedTapPoint, { x: 12, y: 14 });
  assert.equal(body.pipeSize, "1 inch");
  assert.equal(body.systemType, "Domestic Cold Water");
  assert.equal(body.orientation, "top");
  assert.equal(body.apply, false);
});

test("MEP route redline resolver blocks tap evidence for the wrong MEP kind", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: targetPathAnalysisWithLabel("Add top tap off existing 12x10 supply duct for new branch"),
    user_text: "Pick up the attached MEP redline from marked.pdf.",
    verified_mep_tap_branch: {
      kind: "pipe",
      viewId: 1363433,
      visualViewId: 1363433,
      mainElementId: 1542001,
      projectedTapPoint: { x: 82, y: -45, z: 43 },
      branchPoints: [{ x: 82, y: -45, z: 43 }, { x: 88, y: -45, z: 43 }],
      pipeSize: "1 inch",
      connectionMode: "tap",
      expectedFitting: "takeoff"
    }
  }));

  assert.equal(response.handled, true);
  assert.equal(response.ok, false);
  assert.equal(response.next_action, undefined);
  assert.match(response.assistant_message, /Missing verified evidence/i);
  assert.equal(response.task?.warnings.some(w => /kind pipe must match detected redline kind duct/i.test(w)), true);
});

test("MEP route redline resolver reports verified tap dry-run results", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: targetPathAnalysisWithLabel("Add top tap off existing 12x10 supply duct for new branch"),
    user_text: "Pick up the attached MEP redline from marked.pdf.",
    tool_results: [
      {
        action_id: "tap-dry-run",
        method: "POST",
        path: "/revit/connect-mep-branch",
        status: "done",
        result_json: {
          status: "DryRunReady",
          dryRunElementIds: [1543001],
          dryRunFittingIds: [1543002],
          splitPlan: { projectedSplitPoint: { x: 82, y: -45, z: 43 }, expectedFitting: "takeoff" },
          selected: { size: "8x8" },
          connectorAudit: { status: "planned" },
          connectionAttempts: [{ connected: true, fittingId: 1543002 }]
        }
      }
    ]
  }));

  assert.equal(response.handled, true);
  assert.equal(response.ok, true);
  assert.equal(response.next_action, undefined);
  assert.equal(response.task?.verification?.status, "dry_run_ready");
  assert.deepEqual(response.task?.verification?.created_element_ids, [1543001]);
  assert.deepEqual(response.task?.verification?.created_fitting_ids, [1543002]);
  assert.match(response.assistant_message, /completed without model writes/i);
  assert.match(response.assistant_message, /branch size 8x8/i);
});

test("MEP route redline resolver blocks size transition edits before free route planning", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: targetPathAnalysisWithLabel("Change 12x10 duct to 16x14 with reducer transition here"),
    user_text: "Pick up the attached MEP redline from marked.pdf."
  }));

  assert.equal(response.handled, true);
  assert.equal(response.ok, false);
  assert.equal(response.next_action, undefined);
  assert.match(response.blocker ?? "", /size transition\/reducer edit/i);
  assert.match(response.blocker ?? "", /host element id|scoped segment ids/i);
});

test("MEP route redline resolver dry-runs verified size transition evidence instead of free routing", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: targetPathAnalysisWithLabel("Change 12x10 duct to 16x14 with reducer transition here"),
    user_text: "Pick up the attached MEP redline from marked.pdf.",
    verified_mep_size_transition: {
      kind: "duct",
      viewId: 1363433,
      visualViewId: 1363433,
      hostElementId: 1542001,
      transitionNormalized: 0.45,
      upstreamDuctSize: "12x10",
      downstreamDuctSize: "16x14",
      expectedFitting: "transition"
    }
  }));

  assert.equal(response.handled, true);
  assert.equal(response.ok, true);
  assert.equal(response.next_action?.path, "/revit/reroute-mep-route-segment");
  const body = response.next_action?.body as any;
  assert.equal(body.operation, "size_transition");
  assert.equal(body.kind, "duct");
  assert.equal(body.hostElementId, 1542001);
  assert.equal(body.transitionNormalized, 0.45);
  assert.equal(body.upstreamDuctSize, "12x10");
  assert.equal(body.downstreamDuctSize, "16x14");
  assert.equal(body.expectedFitting, "transition");
  assert.equal(body.apply, false);
  assert.equal(body.verifyConnectorNetwork, true);
  assert.equal(body.visualVerify, false);
  assert.equal(body.cleanupCreatedElements, false);
  assert.match(response.assistant_message, /dry-run/);
});

test("MEP route redline resolver accepts verified size transition evidence from context", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: targetPathAnalysisWithLabel("Change 2 inch pipe to 1 inch with reducer transition here"),
    user_text: "Pick up the attached plumbing redline from marked.pdf.",
    context: {
      verifiedMepSizeTransition: {
        kind: "pipe",
        viewId: 1363433,
        visualViewId: 1363433,
        hostElementId: 1642001,
        transitionPoint: { x: 82, y: -55, z: 43 },
        upstreamPipeSize: "2 inch",
        downstreamPipeSize: "1 inch",
        expectedFitting: "reducer"
      }
    }
  }));

  assert.equal(response.ok, true);
  assert.equal(response.next_action?.path, "/revit/reroute-mep-route-segment");
  const body = response.next_action?.body as any;
  assert.equal(body.kind, "pipe");
  assert.equal(body.hostElementId, 1642001);
  assert.deepEqual(body.transitionPoint, { x: 82, y: -55, z: 43 });
  assert.equal(body.upstreamPipeSize, "2 inch");
  assert.equal(body.downstreamPipeSize, "1 inch");
  assert.equal(body.apply, false);
});

test("MEP route redline resolver blocks size transition evidence for the wrong MEP kind", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: targetPathAnalysisWithLabel("Change 12x10 duct to 16x14 with reducer transition here"),
    user_text: "Pick up the attached MEP redline from marked.pdf.",
    verified_mep_size_transition: {
      kind: "pipe",
      viewId: 1363433,
      visualViewId: 1363433,
      hostElementId: 1542001,
      transitionNormalized: 0.45,
      upstreamPipeSize: "1 inch",
      downstreamPipeSize: "2 inch",
      expectedFitting: "reducer"
    }
  }));

  assert.equal(response.handled, true);
  assert.equal(response.ok, false);
  assert.equal(response.next_action, undefined);
  assert.match(response.assistant_message, /Missing verified evidence/i);
  assert.equal(response.task?.warnings.some(w => /kind pipe must match detected redline kind duct/i.test(w)), true);
});

test("MEP route redline resolver reports verified size transition dry-run results", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: targetPathAnalysisWithLabel("Change 12x10 duct to 16x14 with reducer transition here"),
    user_text: "Pick up the attached MEP redline from marked.pdf.",
    tool_results: [
      {
        action_id: "transition-dry-run",
        method: "POST",
        path: "/revit/reroute-mep-route-segment",
        status: "done",
        result_json: {
          status: "DryRunReady",
          dryRunElementIds: [1542001, 1542002],
          dryRunFittingIds: [1542003],
          projectedTransitionPoint: { x: 82, y: -45, z: 43 },
          sizeReadback: { upstreamDuctSize: "12x10", downstreamDuctSize: "16x14" },
          connectorAudit: { status: "planned" }
        }
      }
    ]
  }));

  assert.equal(response.handled, true);
  assert.equal(response.ok, true);
  assert.equal(response.next_action, undefined);
  assert.equal(response.task?.verification?.status, "dry_run_ready");
  assert.deepEqual(response.task?.verification?.created_element_ids, [1542001, 1542002]);
  assert.deepEqual(response.task?.verification?.created_fitting_ids, [1542003]);
  assert.match(response.assistant_message, /completed without model writes/i);
  assert.match(response.assistant_message, /12x10 -> 16x14/i);
});

test("MEP route redline resolver blocks reroute and elevation edits before free route planning", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: targetPathAnalysisWithLabel("Reroute existing 12x10 supply duct with 45 degree offset and drop 1 ft"),
    user_text: "Pick up the attached MEP redline from marked.pdf."
  }));

  assert.equal(response.handled, true);
  assert.equal(response.ok, false);
  assert.equal(response.next_action, undefined);
  assert.match(response.blocker ?? "", /reroute\/offset\/elevation edit/i);
  assert.match(response.blocker ?? "", /host route id/i);
});

test("MEP route redline resolver dry-runs verified duct reroute evidence instead of free routing", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: targetPathAnalysisWithLabel("Reroute existing 12x10 supply duct with 45 degree offset and drop 1 ft"),
    user_text: "Pick up the attached MEP redline from marked.pdf.",
    verified_mep_reroute_offset: {
      kind: "duct",
      viewId: 1363433,
      visualViewId: 1363433,
      hostElementId: 1542919,
      splitPoints: [{ x: 76, y: -35, z: 43 }, { x: 88, y: -35, z: 43 }],
      offsetVector: { x: 0, y: 0, z: -1 },
      offsetMode: "dogleg45",
      expectedFittings: "four connected elbows",
      preserveConnectedEndpoints: false
    }
  }));

  assert.equal(response.handled, true);
  assert.equal(response.ok, true);
  assert.equal(response.next_action?.path, "/revit/reroute-mep-route-segment");
  const body = response.next_action?.body as any;
  assert.equal(body.operation, "reroute_offset");
  assert.equal(body.kind, "duct");
  assert.equal(body.hostElementId, 1542919);
  assert.deepEqual(body.splitPoints, [{ x: 76, y: -35, z: 43 }, { x: 88, y: -35, z: 43 }]);
  assert.deepEqual(body.offsetVector, { x: 0, y: 0, z: -1 });
  assert.equal(body.offsetMode, "dogleg45");
  assert.equal(body.expectedFittings, "four connected elbows");
  assert.equal(body.preserveConnectedEndpoints, false);
  assert.equal(body.apply, false);
  assert.equal(body.verifyConnectorNetwork, true);
  assert.equal(body.visualVerify, false);
  assert.equal(body.cleanupCreatedElements, false);
  assert.match(response.assistant_message, /dry-run/);
});

test("MEP route redline resolver accepts verified pipe reroute evidence from context", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: targetPathAnalysisWithLabel("Offset existing 2 inch pipe under the crossing main and reconnect"),
    user_text: "Pick up the attached plumbing redline from marked.pdf.",
    context: {
      verifiedMepRerouteOffset: {
        kind: "pipe",
        viewId: 1363433,
        visualViewId: 1363433,
        hostElementId: 1642919,
        split1ChainageFt: 4,
        split2ChainageFt: 12,
        dropFt: 1,
        offsetMode: "vertical_drop",
        expectedFitting: "four elbows",
        preserveConnectedEndpoints: true,
        endpointReconnectionPlanReviewed: true
      }
    }
  }));

  assert.equal(response.ok, true);
  assert.equal(response.next_action?.path, "/revit/reroute-mep-route-segment");
  const body = response.next_action?.body as any;
  assert.equal(body.kind, "pipe");
  assert.equal(body.hostElementId, 1642919);
  assert.equal(body.split1ChainageFt, 4);
  assert.equal(body.split2ChainageFt, 12);
  assert.equal(body.dropFt, 1);
  assert.equal(body.offsetMode, "vertical_drop");
  assert.equal(body.expectedFittings, "four elbows");
  assert.equal(body.preserveConnectedEndpoints, true);
  assert.equal(body.apply, false);
});

test("MEP route redline resolver blocks connected reroute evidence until endpoint plan is reviewed", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: targetPathAnalysisWithLabel("Reroute existing 12x10 supply duct with 45 degree offset and reconnect endpoints"),
    user_text: "Pick up the attached MEP redline from marked.pdf.",
    verified_mep_reroute_offset: {
      kind: "duct",
      viewId: 1363433,
      visualViewId: 1363433,
      hostElementId: 1542919,
      splitPoints: [{ x: 76, y: -35, z: 43 }, { x: 88, y: -35, z: 43 }],
      offsetVector: { x: 0, y: 0, z: -1 },
      offsetMode: "dogleg45",
      expectedFittings: "four connected elbows",
      preserveConnectedEndpoints: true
    }
  }));

  assert.equal(response.handled, true);
  assert.equal(response.ok, false);
  assert.equal(response.next_action, undefined);
  assert.match(response.assistant_message, /Missing verified evidence/i);
  assert.equal(response.task?.warnings.some(w => /endpoint reconnection plan/i.test(w)), true);
});

test("MEP route redline resolver reports verified reroute dry-run results", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: targetPathAnalysisWithLabel("Reroute existing 12x10 supply duct with 45 degree offset and drop 1 ft"),
    user_text: "Pick up the attached MEP redline from marked.pdf.",
    tool_results: [
      {
        action_id: "reroute-dry-run",
        method: "POST",
        path: "/revit/reroute-mep-route-segment",
        status: "done",
        result_json: {
          status: "DryRunReady",
          dryRunElementIds: [1542921, 1542923],
          dryRunFittingIds: [1542931, 1542933],
          plan: {
            Split1: { X: 76, Y: -35, Z: 43 },
            Split2: { X: 88, Y: -35, Z: 43 },
            OffsetSplit1: { X: 76, Y: -35, Z: 42 },
            OffsetSplit2: { X: 88, Y: -35, Z: 42 },
            Segments: [{ Role: "offset_leg_a" }, { Role: "offset_middle" }],
            ExpectedFittings: [{ ExpectedFitting: "elbow" }, { ExpectedFitting: "elbow" }]
          },
          verification: { networkAudit: { status: "planned", systemAudit: { status: "planned" } } },
          connectionAttempts: [{ connected: true, fittingId: 1542931 }, { connected: true, fittingId: 1542933 }]
        }
      }
    ]
  }));

  assert.equal(response.handled, true);
  assert.equal(response.ok, true);
  assert.equal(response.next_action, undefined);
  assert.equal(response.task?.verification?.status, "dry_run_ready");
  assert.deepEqual(response.task?.verification?.created_element_ids, [1542921, 1542923]);
  assert.deepEqual(response.task?.verification?.created_fitting_ids, [1542931, 1542933]);
  assert.match(response.assistant_message, /completed without model writes/i);
  assert.match(response.assistant_message, /split and offset points reported/i);
});

test("MEP route redline resolver blocks accessory and type-change edits before free route planning", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: targetPathAnalysisWithLabel("Replace fire damper type on 12x10 supply duct"),
    user_text: "Pick up the attached MEP redline from marked.pdf."
  }));

  assert.equal(response.handled, true);
  assert.equal(response.ok, false);
  assert.equal(response.next_action, undefined);
  assert.match(response.blocker ?? "", /MEP accessory edit|targeted MEP move\/delete\/type/i);
  assert.match(response.blocker ?? "", /family\/type|target ids/i);
});

test("MEP route redline classifier treats nearby MEP text as a label for separate route geometry", () => {
  const classified = __testOnlyClassifyRedlineGeometry(baseAnalysis());

  assert.equal(classified.has_target_path, true);
  assert.equal(classified.callout_only, false);
  assert.equal(classified.ambiguity, "mixed_callout_and_target_path");
  assert.equal(classified.roles.some(r => r.role === "target_path" && r.annotation_id === "109R" && /12x10 supply/i.test(r.associated_text ?? "")), true);
  assert.equal(classified.roles.some(r => r.role === "callout_text" && r.annotation_id === "111R"), true);
});

test("MEP route redline classifier still detects true typographic underlines", () => {
  const classified = __testOnlyClassifyRedlineGeometry(underlineAnalysis());

  assert.equal(classified.has_target_path, false);
  assert.equal(classified.callout_only, true);
  assert.equal(classified.roles.some(r => r.role === "underline" && r.annotation_id === "underline-1"), true);
  assert.equal(classified.roles.some(r => r.role === "callout_text" && r.annotation_id === "111R"), true);
});

test("MEP redline analyzer builds labeled route candidates and rejects true text underlines", () => {
  const candidates = __testOnlyBuildRedlineRouteCandidates([
    {
      page: 1,
      annotation_index: 1,
      id: "underline-1",
      subtype: "PolyLine",
      is_red_like: true,
      box_norm: { minX: 0.39, minY: 0.665, maxX: 0.55, maxY: 0.67 },
      vertices_norm: [{ x: 0.39, y: 0.667 }, { x: 0.55, y: 0.667 }],
      related_annotation_indices: [2],
      related_text: "12x10 supply duct"
    },
    {
      page: 1,
      annotation_index: 2,
      id: "text-1",
      subtype: "FreeText",
      is_red_like: false,
      contents: "12x10 supply duct",
      box_norm: { minX: 0.39, minY: 0.58, maxX: 0.55, maxY: 0.67 },
      related_annotation_indices: [1, 3]
    },
    {
      page: 1,
      annotation_index: 3,
      id: "route-actual",
      subtype: "PolyLine",
      is_red_like: true,
      box_norm: { minX: 0.3, minY: 0.8, maxX: 0.5, maxY: 0.9 },
      vertices_norm: [{ x: 0.3, y: 0.8 }, { x: 0.5, y: 0.8 }, { x: 0.5, y: 0.9 }],
      related_annotation_indices: [2],
      related_text: "12x10 supply duct"
    }
  ]);

  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0]?.target_annotation_indices, [3]);
  assert.equal(candidates[0]?.label_text, "12x10 supply duct");
  assert.equal(candidates[0]?.size_text, "12x10");
  assert.equal(candidates[0]?.mep_kind_hint, "duct");
  assert.equal(candidates[0]?.vertices_norm.length, 3);
});

test("MEP redline analyzer builds pipe route candidates from nearby pipe labels", () => {
  const candidates = __testOnlyBuildRedlineRouteCandidates([
    {
      page: 1,
      annotation_index: 1,
      id: "pipe-line",
      subtype: "PolyLine",
      is_red_like: true,
      box_norm: { minX: 0.25, minY: 0.74, maxX: 0.48, maxY: 0.75 },
      vertices_norm: [{ x: 0.25, y: 0.745 }, { x: 0.48, y: 0.745 }],
      related_annotation_indices: [2]
    },
    {
      page: 1,
      annotation_index: 2,
      id: "pipe-label",
      subtype: "FreeText",
      is_red_like: false,
      contents: "6-inch water pipe",
      box_norm: { minX: 0.25, minY: 0.65, maxX: 0.5, maxY: 0.71 },
      related_annotation_indices: [1]
    }
  ]);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.mep_kind_hint, "pipe");
  assert.equal(candidates[0]?.size_text, '6"');
  assert.deepEqual(candidates[0]?.target_annotation_indices, [1]);
});

test("MEP route redline resolver verifies scoped ductwork for callout-only redlines after sheet detail", async () => {
  const response = await resolveMepRouteRedline(request({ analysis: underlineAnalysis(), tool_results: [sheetDetailToolResult()] }));

  assert.equal(response.handled, true);
  assert.equal(response.next_action?.path, "/revit/ducts-by-spatial-scope");
  assert.equal((response.next_action?.body as any).roomNumber, "405");
  assert.equal((response.next_action?.body as any).sizeFrom, undefined);
  assert.equal(response.task?.viewport?.view_id, 1363433);
});

test("MEP route redline resolver maps annotation geometry to pick-at-pixel", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: targetPathAnalysis(),
    tool_results: [
      sheetDetailToolResult(),
      {
        action_id: "frame",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: { frameId: "frame-1", viewId: 1363433, widthPx: 2200, heightPx: 1223 }
      }
    ]
  }));

  assert.equal(response.handled, true);
  assert.equal(response.next_action?.path, "/revit/pick-at-pixel");
  const body = response.next_action?.body as any;
  assert.equal(body.frameId, "frame-1");
  assert.equal(body.xPx, 1298);
  assert.equal(body.yPx, 746);
});

test("MEP route redline resolver requests visual frame alignment before picking when redline preview exists", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: targetPathAnalysisWithPreview(),
    tool_results: [
      sheetDetailToolResult(),
      {
        action_id: "frame",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-1",
          viewId: 1363433,
          widthPx: 2200,
          heightPx: 1223,
          path: "C:/Users/User/source/repos/RevitOperator/artifacts/captures/frame.jpg"
        }
      }
    ]
  }));

  assert.equal(response.handled, true);
  assert.equal(response.next_action?.path, "/tools/redline/align-to-view");
  const body = response.next_action?.body as any;
  assert.equal(body.redline_file_path, "artifacts/redline/marked_page_01.png");
  assert.match(body.view_image_path, /frame\.jpg$/);
});

test("MEP route redline resolver prefers route candidate crop for visual frame alignment", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: competingRouteCandidateAnalysis(),
    tool_results: [
      sheetDetailToolResult(),
      {
        action_id: "frame",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-1",
          viewId: 1363433,
          widthPx: 2200,
          heightPx: 1223,
          path: "C:/Users/User/source/repos/RevitOperator/artifacts/captures/frame.jpg"
        }
      }
    ]
  }));

  assert.equal(response.handled, true);
  assert.equal(response.next_action?.path, "/tools/redline/align-to-view");
  assert.equal((response.next_action?.body as any).redline_file_path, "artifacts/redline/route_candidate_01.png");
});

test("MEP route redline resolver uses visual alignment pick and permits apply only after verified alignment", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: targetPathAnalysisWithPreview(),
    user_text:
      "Implement the redline: add the 12x10 supply duct on M104 near Live/Work Loft Unit 405. If connectors cannot resolve, place unconnected.",
    tool_results: [
      sheetDetailToolResult(),
      frameWithMappingToolResult(),
      {
        action_id: "align",
        method: "POST",
        path: "/tools/redline/align-to-view",
        status: "done",
        result_json: {
          ok: true,
          matched: true,
          confidence: 0.88,
          marks: [{ normalized_x: 0.42, normalized_y: 0.78, score: 0.9, label: "12x10 supply duct route" }]
        }
      },
      visibleUnit405ToolResult(),
      {
        action_id: "pick",
        method: "POST",
        path: "/revit/pick-at-pixel",
        status: "done",
        result_json: { pickPointXyz: [-15.663, -17.933, -467.883], best: null, hits: [] }
      },
      {
        action_id: "context",
        method: "POST",
        path: "/revit/resolve-mep-routing-context",
        status: "done",
        result_json: {
          status: "Ok",
          view: { id: 1363433, name: "L4", type: "FloorPlan" },
          level: { id: 1362791, name: "L4", elevation: 32.1667 },
          recommendedElevation: { zFt: 38.8333, mode: "between_levels_midpoint", confidence: "low" }
        }
      }
    ]
  }));

  assert.equal(response.handled, true);
  assert.equal(response.next_action?.path, "/revit/mep-route-workflow");
  const body = response.next_action?.body as any;
  assert.equal(body.apply, true);
  assert.equal(body.visualVerify, true);
  assert.equal(response.task?.viewport?.pick_px?.x, 924);
  assert.equal(response.task?.viewport?.pick_px?.y, 954);
  assert.equal(response.task?.warnings.some(w => /PDF redline vector/i.test(w)), true);
});

test("MEP route redline resolver projects route endpoints instead of text-biased alignment mark", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: targetPathAnalysis(),
    user_text:
      "Implement the redline: add the 12x10 supply duct on M104 near Live/Work Loft Unit 405. If connectors cannot resolve, place unconnected.",
    tool_results: [
      sheetDetailToolResult(),
      frameWithMappingToolResult(),
      {
        action_id: "align",
        method: "POST",
        path: "/tools/redline/align-to-view",
        status: "done",
        result_json: {
          ok: true,
          matched: true,
          confidence: 0.91,
          crop: { min_u: 0.1, min_v: 0.2, max_u: 0.6, max_v: 0.7 },
          marks: [{ normalized_x: 0.5, normalized_y: 0.78, score: 0.9, label: "text-biased route mark" }]
        }
      },
      visibleUnit405ToolResult(),
      contextToolResult()
    ]
  }));

  assert.equal(response.handled, true);
  assert.equal(response.next_action?.path, "/revit/mep-route-workflow");
  const body = response.next_action?.body as any;
  assert.equal(body.apply, true);
  assert.equal(body.points.length, 2);
  assert.ok(Math.abs(body.points[0].x - 40) < 0.01);
  assert.ok(Math.abs(body.points[1].x - 58) < 0.01);
  assert.ok(Math.abs(body.points[0].y - 27) < 0.01);
  assert.ok(Math.abs(body.points[1].y - 27) < 0.01);
  assert.notEqual(Math.round(body.points[0].y), 22);
  assert.equal(response.task?.warnings.some(w => /PDF redline vector/i.test(w)), true);
});

test("MEP route redline resolver requests visible Unit 405 anchors before applying route geometry", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: targetPathAnalysisWithRouteCrop(),
    user_text:
      "Implement the redline: add the 12x10 supply duct on M104 near Live/Work Loft Unit 405. If connectors cannot resolve, place unconnected.",
    tool_results: [
      sheetDetailToolResult(),
      frameWithMappingToolResult(),
      {
        action_id: "align",
        method: "POST",
        path: "/tools/redline/align-to-view",
        status: "done",
        result_json: {
          ok: true,
          matched: true,
          confidence: 0.91,
          crop: { min_u: 0.1, min_v: 0.2, max_u: 0.6, max_v: 0.7 },
          marks: [{ normalized_x: 0.5, normalized_y: 0.78, score: 0.9, label: "text-biased route mark" }]
        }
      }
    ]
  }));

  assert.equal(response.handled, true);
  assert.equal(response.next_action?.path, "/revit/export-visible-elements");
  const body = response.next_action?.body as any;
  assert.equal(body.viewId, 1363433);
  assert.equal(body.limit, 120);
  assert.equal(body.maxResults, undefined);
  assert.equal(body.includeMapping, true);
  assert.match(response.assistant_message, /visible Unit 405 anchors/i);
});

test("MEP route redline resolver treats pick up redline as apply intent for modeled routes", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: targetPathAnalysis(),
    user_text: "pick up redline from marked.pdf for Live/Work Loft Unit 405",
    tool_results: [
      sheetDetailToolResult(),
      frameWithMappingToolResult()
    ]
  }));

  assert.equal(response.handled, true);
  assert.equal(response.next_action?.path, "/revit/export-visible-elements");
});

test("MEP route redline resolver prefers full Live Work Loft Unit label over earlier adjacent unit text", async () => {
  const analysis = {
    ...targetPathAnalysis(),
    pages: [{ page: 1, text_excerpt: "Live/Work Loft Unit 403 corridor notes near Live/Work Loft Unit 405" }]
  } as RedlineAnalyzeResponse;
  const response = await resolveMepRouteRedline(request({
    analysis,
    user_text: "pick up redline from marked.pdf",
    tool_results: [
      sheetDetailToolResult(),
      frameWithMappingToolResult()
    ]
  }));

  assert.equal(response.handled, true);
  assert.equal(response.next_action?.path, "/revit/export-visible-elements");
  assert.match(response.assistant_message, /room\/unit anchors/i);
});

test("MEP route redline resolver blocks route projected into bathroom kitchen band", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: kitchenBandRouteAnalysis(),
    user_text:
      "Implement the redline: add the 12x10 supply duct on M104 near Live/Work Loft Unit 405. If connectors cannot resolve, place unconnected.",
    tool_results: [
      sheetDetailToolResult(),
      frameWithMappingToolResult(),
      {
        action_id: "align",
        method: "POST",
        path: "/tools/redline/align-to-view",
        status: "done",
        result_json: {
          ok: true,
          matched: true,
          confidence: 0.91,
          crop: { min_u: 0.1, min_v: 0.2, max_u: 0.6, max_v: 0.7 },
          marks: [{ normalized_x: 0.5, normalized_y: 0.28, score: 0.9, label: "wrong repeated corridor match" }]
        }
      },
      visibleUnit405ToolResult(),
      contextToolResult()
    ]
  }));

  assert.equal(response.ok, false);
  assert.equal(response.handled, true);
  assert.equal(response.next_action, undefined);
  assert.equal(response.task?.verification?.local_band_assertion?.status, "failed");
  assert.match(response.assistant_message, /bathroom\/kitchen\/loft fixture band/i);
});

test("MEP route redline resolver shifts upper fixture-band route into space-bounded Unit 405 band", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: upperFixtureBandAnalysis(),
    user_text:
      "Implement the redline: add the 12x10 supply duct on M104 near Live/Work Loft Unit 405. If connectors cannot resolve, place unconnected.",
    tool_results: [
      sheetDetailToolResult(),
      frameWithMappingToolResult(),
      visibleUnit405SpaceOnlyToolResult(),
      contextToolResult()
    ]
  }));

  assert.equal(response.ok, true);
  assert.equal(response.handled, true);
  assert.equal(response.next_action?.path, "/revit/mep-route-workflow");
  const body = response.next_action?.body as any;
  assert.equal(body.apply, true);
  assert.equal(body.visualVerify, true);
  assert.equal(body.points.length, 2);
  assert.ok(Math.abs(body.points[0].x - 50.28) < 0.1);
  assert.ok(Math.abs(body.points[1].x - 54.31) < 0.1);
  assert.ok(Math.abs(body.points[0].y - 25.87) < 0.1);
  assert.ok(Math.abs(body.points[1].y - 25.87) < 0.1);
  assert.equal(response.task?.verification, undefined);
  assert.equal(response.task?.warnings.some(w => /centered on the target space/i.test(w)), true);
});

test("MEP route redline resolver creates route workflow after context without view-plane z", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: targetPathAnalysis(),
    user_text:
      'Implement the redline: add the 12x10 supply duct on M104 near Live/Work Loft Unit 405. If connectors cannot resolve, place unconnected.',
    tool_results: [
      sheetDetailToolResult(),
      {
        action_id: "frame",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: { frameId: "frame-1", viewId: 1363433, widthPx: 2200, heightPx: 1223 }
      },
      {
        action_id: "pick",
        method: "POST",
        path: "/revit/pick-at-pixel",
        status: "done",
        result_json: { pickPointXyz: [-2.718, -9.101, -467.883], best: null, hits: [] }
      },
      {
        action_id: "context",
        method: "POST",
        path: "/revit/resolve-mep-routing-context",
        status: "done",
        result_json: {
          status: "Ok",
          view: { id: 1363433, name: "L4", type: "FloorPlan" },
          level: { id: 1362791, name: "L4", elevation: 32.1667 },
          recommendedElevation: { zFt: 38.8333, mode: "between_levels_midpoint", confidence: "low" }
        }
      }
    ]
  }));

  assert.equal(response.handled, true);
  assert.equal(response.next_action?.path, "/revit/mep-route-workflow");
  const body = response.next_action?.body as any;
  assert.equal(body.viewId, 1363433);
  assert.equal(body.roomNumber, "405");
  assert.equal(body.levelName, "L4");
  assert.equal(body.systemType, "Supply Air");
  assert.equal(body.ductSize, "12x10");
  assert.equal(body.apply, false);
  assert.equal(body.visualVerify, false);
  assert.equal(body.points.length, 2);
  assert.match(response.assistant_message, /alignment is not verified enough to write/i);
  assert.equal(response.task?.warnings.some(w => /sheet viewport math only/i.test(w)), true);
  assert.equal(body.points[0].z, undefined);
  assert.equal(body.points[1].z, undefined);
  assert.notDeepEqual(body.points, [
    { x: -18.718, y: -9.101 },
    { x: 9.282, y: -9.101 },
    { x: 9.282, y: 2.899 }
  ]);
});

test("MEP route redline resolver prefers grouped route candidate over competing underline geometry", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: competingRouteCandidateAnalysis(),
    user_text:
      "Implement the redline: add the 12x10 supply duct on M104 near Live/Work Loft Unit 405. If connectors cannot resolve, place unconnected.",
    tool_results: [
      sheetDetailToolResult(),
      {
        action_id: "frame",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: { frameId: "frame-1", viewId: 1363433, widthPx: 2200, heightPx: 1223 }
      },
      {
        action_id: "pick",
        method: "POST",
        path: "/revit/pick-at-pixel",
        status: "done",
        result_json: { pickPointXyz: [-2.718, -9.101, -467.883], best: null, hits: [] }
      },
      {
        action_id: "context",
        method: "POST",
        path: "/revit/resolve-mep-routing-context",
        status: "done",
        result_json: {
          status: "Ok",
          view: { id: 1363433, name: "L4", type: "FloorPlan" },
          level: { id: 1362791, name: "L4", elevation: 32.1667 },
          recommendedElevation: { zFt: 38.8333, mode: "between_levels_midpoint", confidence: "low" }
        }
      }
    ]
  }));

  assert.equal(response.handled, true);
  assert.equal(response.next_action?.path, "/revit/mep-route-workflow");
  assert.equal(response.task?.redline.geometry_classification?.route_candidate?.candidate_index, 1);
  assert.deepEqual(response.task?.redline.geometry_classification?.route_candidate?.target_annotation_indices, [3]);
  const body = response.next_action?.body as any;
  assert.equal(body.points.length, 3);
  assert.equal(body.apply, false);
  assert.equal(body.visualVerify, false);
  assert.notEqual(body.points[0].y, body.points[2].y);
});

test("MEP route redline resolver creates pipe workflow from labeled red line geometry", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: pipePathAnalysis(),
    user_text:
      'Implement the redline: add the 6-inch water pipe on M104 near Live/Work Loft Unit 405. If connectors cannot resolve, place unconnected.',
    tool_results: [
      sheetDetailToolResult(),
      {
        action_id: "frame",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: { frameId: "frame-1", viewId: 1363433, widthPx: 2200, heightPx: 1223 }
      },
      {
        action_id: "pick",
        method: "POST",
        path: "/revit/pick-at-pixel",
        status: "done",
        result_json: { pickPointXyz: [-2.718, -9.101, -467.883], best: null, hits: [] }
      },
      {
        action_id: "context",
        method: "POST",
        path: "/revit/resolve-mep-routing-context",
        status: "done",
        result_json: {
          status: "Ok",
          view: { id: 1363433, name: "L4", type: "FloorPlan" },
          level: { id: 1362791, name: "L4", elevation: 32.1667 },
          recommendedElevation: { zFt: 38.8333, mode: "between_levels_midpoint", confidence: "low" }
        }
      }
    ]
  }));

  assert.equal(response.handled, true);
  assert.equal(response.next_action?.path, "/revit/mep-route-workflow");
  const body = response.next_action?.body as any;
  assert.equal(body.kind, "pipe");
  assert.equal(body.pipeSize, '6"');
  assert.equal(body.ductSize, undefined);
  assert.equal(body.apply, false);
  assert.equal(body.visualVerify, false);
  assert.equal(body.points.length, 2);
});

test("MEP route redline resolver prefers pipe-compatible candidate over higher-confidence duct candidate", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: mixedPipeAndDuctRouteCandidateAnalysis(),
    user_text:
      'Implement the redline: add the 6-inch water pipe on M104 near Live/Work Loft Unit 405. If connectors cannot resolve, place unconnected.',
    tool_results: [
      sheetDetailToolResult(),
      {
        action_id: "frame",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: { frameId: "frame-1", viewId: 1363433, widthPx: 2200, heightPx: 1223 }
      },
      {
        action_id: "pick",
        method: "POST",
        path: "/revit/pick-at-pixel",
        status: "done",
        result_json: { pickPointXyz: [-2.718, -9.101, -467.883], best: null, hits: [] }
      },
      contextToolResult()
    ]
  }));

  assert.equal(response.handled, true);
  assert.equal(response.next_action?.path, "/revit/mep-route-workflow");
  assert.equal(response.task?.redline.geometry_classification?.route_candidate?.candidate_index, 2);
  assert.deepEqual(response.task?.redline.geometry_classification?.route_candidate?.target_annotation_indices, [3]);
  const body = response.next_action?.body as any;
  assert.equal(body.kind, "pipe");
  assert.equal(body.pipeSize, '6"');
  assert.equal(body.ductSize, undefined);
  assert.equal(body.points.length, 2);
  assert.equal(body.apply, false);
  assert.equal(body.visualVerify, false);
});

test("MEP route redline resolver completes callout-only redline only after scoped model evidence and crop", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: underlineAnalysis(),
    tool_results: [
      sheetDetailToolResult(),
      {
        action_id: "scope",
        method: "POST",
        path: "/revit/ducts-by-spatial-scope",
        status: "done",
        result_json: {
          status: "Ok",
          elementIds: [1542987],
          elements: [{ id: 1542987, category: "Ducts", categoryToken: "OST_DuctCurves", systemName: "Mechanical Supply Air 52", size: "12\"x10\"" }]
        }
      },
      {
        action_id: "summary",
        method: "POST",
        path: "/revit/get-element-summary",
        status: "done",
        result_json: [
          {
            id: 1542987,
            found: true,
            category: "Ducts",
            location: {
              type: "curve",
              curveType: "Line",
              p0: { x: -15.663, y: -17.933, z: 38.833 },
              p1: { x: -2.273, y: -17.933, z: 38.833 }
            }
          }
        ]
      },
      {
        action_id: "crop",
        method: "POST",
        path: "/revit/highlight-and-export",
        status: "done",
        result_json: { path: "C:/captures/unit405_correct_crop.jpg", widthPx: 2200, heightPx: 1223 }
      }
    ]
  }));

  assert.equal(response.ok, true);
  assert.equal(response.handled, true);
  assert.equal(response.next_action, undefined);
  assert.equal(response.task?.verification?.status, "existing_model_verified");
  assert.deepEqual(response.task?.verification?.existing_element_ids, [1542987]);
  assert.equal(response.task?.verification?.spatial_assertion?.status, "passed");
  assert.match(response.assistant_message, /1542987/);
  assert.match(response.assistant_message, /unit405_correct_crop/);
});

test("MEP route redline resolver blocks callout-only redline when no matching scoped duct exists", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: underlineAnalysis(),
    tool_results: [
      sheetDetailToolResult(),
      {
        action_id: "scope",
        method: "POST",
        path: "/revit/ducts-by-spatial-scope",
        status: "done",
        result_json: { status: "Ok", elementIds: [], elements: [] }
      }
    ]
  }));

  assert.equal(response.ok, false);
  assert.equal(response.handled, true);
  assert.equal(response.next_action, undefined);
  assert.match(response.blocker ?? "", /callout\/underline/i);
  assert.match(response.blocker ?? "", /will not fabricate duct geometry/i);
});

test("MEP route redline resolver blocks text-only MEP labels without route geometry", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: baseAnalysis({
      mark_regions: [
        {
          index: 1,
          source: "pdf_annotation",
          x: 500,
          y: 600,
          w: 100,
          h: 40,
          area: 4000,
          annotation_subtype: "FreeText",
          annotation_contents: "12x10 supply duct"
        }
      ],
      pdf_annotations: [
        {
          page: 1,
          annotation_index: 1,
          id: "text-only-1",
          subtype: "FreeText",
          is_red_like: false,
          contents: "12x10 supply duct",
          box_norm: { minX: 0.39, minY: 0.58, maxX: 0.55, maxY: 0.67 }
        }
      ]
    })
  }));

  assert.equal(response.handled, true);
  assert.equal(response.ok, false);
  assert.match(response.blocker ?? "", /only text annotation geometry/i);
  assert.equal(response.next_action, undefined);
});

test("MEP route redline resolver ignores status-only no-discovery turns", async () => {
  const response = await resolveMepRouteRedline(request({
    user_text:
      "Do not make additional discovery calls. Based on the previous session, provide a concise status: did you find explicit redline instructions and were any Revit changes applied?"
  }));

  assert.equal(response.handled, false);
  assert.equal(response.next_action, undefined);
});

test("MEP route redline resolver does not complete applied workflow without intended route assertion", async () => {
  const response = await resolveMepRouteRedline(request({
    tool_results: [
      {
        action_id: "workflow",
        method: "POST",
        path: "/revit/mep-route-workflow",
        status: "done",
        result_json: {
          status: "AppliedVisualVerificationReady",
          applyResult: {
            status: "CreatedWithOpenConnectors",
            plannedPoints: [{ x: 0, y: 0, z: 38 }, { x: 10, y: 0, z: 38 }, { x: 10, y: 6, z: 38 }],
            segmentCount: 2,
            chosenSize: { requested: "12x10", applied: "12x10" },
            createdElementIds: [1542929, 1542931],
            createdFittingIds: [1542933],
            openConnectorCount: 2
          },
          visualVerification: {
            status: "CaptureReadyForAIReview",
            capturePath: "C:/captures/redline.jpg",
            createdElementIds: [1542929, 1542931],
            createdFittingIds: [1542933]
          }
        }
      }
    ]
  }));

  assert.equal(response.ok, false);
  assert.equal(response.handled, true);
  assert.equal(response.next_action, undefined);
  assert.equal(response.task?.verification?.status, "applied_visual_incomplete");
  assert.deepEqual(response.task?.verification?.created_element_ids, [1542929, 1542931]);
  assert.deepEqual(response.task?.verification?.created_fitting_ids, [1542933]);
  assert.equal(response.task?.verification?.open_connector_count, 2);
  assert.equal(response.task?.verification?.capture_path, "C:/captures/redline.jpg");
  assert.equal(response.task?.verification?.spatial_assertion?.status, "not_applicable");
  assert.equal(response.task?.verification?.visual_gate?.status, "uncertain");
  assert.match(response.assistant_message, /1542929/);
  assert.match(response.assistant_message, /open connector count: 2/i);
  assert.match(response.assistant_message, /Do not claim final completion/i);
});

test("MEP route redline resolver spatially verifies created workflow route against intended points", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: targetPathAnalysis(),
    tool_results: [
      sheetDetailToolResult(),
      frameWithMappingToolResult(),
      visibleUnit405ToolResult(),
      {
        action_id: "pick",
        method: "POST",
        path: "/revit/pick-at-pixel",
        status: "done",
        result_json: { pickPointXyz: [-2.718, -9.101, -467.883], best: null, hits: [] }
      },
      {
        action_id: "context",
        method: "POST",
        path: "/revit/resolve-mep-routing-context",
        status: "done",
        result_json: {
          status: "Ok",
          view: { id: 1363433, name: "L4", type: "FloorPlan" },
          level: { id: 1362791, name: "L4", elevation: 32.1667 },
          recommendedElevation: { zFt: 38.8333, mode: "between_levels_midpoint", confidence: "low" }
        }
      },
      {
        action_id: "workflow",
        method: "POST",
        path: "/revit/mep-route-workflow",
        status: "done",
        result_json: {
          status: "AppliedVisualVerificationReady",
          applyResult: {
            status: "CreatedWithOpenConnectors",
            plannedPoints: [{ x: 40, y: 27 }, { x: 58, y: 27 }],
            segmentCount: 1,
            chosenSize: { requested: "12x10", applied: "12x10" },
            createdElementIds: [1542929],
            createdFittingIds: [],
            openConnectorCount: 2
          },
          visualVerification: { status: "CaptureReadyForAIReview", capturePath: "C:/captures/redline.jpg" }
        }
      }
    ]
  }));

  assert.equal(response.ok, true);
  assert.equal(response.task?.verification?.status, "applied_visual_ready");
  assert.equal(response.task?.verification?.spatial_assertion?.status, "passed");
  assert.equal(response.task?.verification?.visual_gate?.status, "pass");
  assert.equal(response.task?.verification?.visual_gate?.authority, "deterministic_geometry");
});

test("MEP route redline resolver refuses completion when route segment ids do not cover requested segments", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: targetThreePointPathAnalysis(),
    tool_results: [
      sheetDetailToolResult(),
      frameWithMappingToolResult(),
      visibleUnit405ToolResult(),
      contextToolResult(),
      {
        action_id: "workflow",
        method: "POST",
        path: "/revit/mep-route-workflow",
        status: "done",
        result_json: {
          status: "AppliedVisualVerificationReady",
          applyResult: {
            status: "CreatedWithOpenConnectors",
            plannedPoints: [{ x: 40, y: 27 }, { x: 49, y: 27 }, { x: 58, y: 27 }],
            segmentCount: 2,
            chosenSize: { requested: "12x10", applied: "12x10" },
            createdElementIds: [1542929],
            createdFittingIds: [1542933],
            openConnectorCount: 2
          },
          visualVerification: { status: "CaptureReadyForAIReview", capturePath: "C:/captures/redline.jpg" }
        }
      }
    ]
  }));

  assert.equal(response.ok, false);
  assert.equal(response.handled, true);
  assert.equal(response.next_action, undefined);
  assert.equal(response.task?.verification?.status, "applied_visual_incomplete");
  assert.equal(response.task?.verification?.visual_gate?.status, "fail");
  assert.equal(response.task?.verification?.visual_gate?.assertions.some(a => a.name === "route_segment_write_evidence_matches" && a.status === "fail"), true);
  assert.match(response.assistant_message, /created route element ID for each requested route segment/i);
});

test("MEP route redline resolver refuses completion when applied workflow omits model write ids", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: targetPathAnalysis(),
    tool_results: [
      sheetDetailToolResult(),
      frameWithMappingToolResult(),
      visibleUnit405ToolResult(),
      contextToolResult(),
      {
        action_id: "workflow",
        method: "POST",
        path: "/revit/mep-route-workflow",
        status: "done",
        result_json: {
          status: "AppliedVisualVerificationReady",
          applyResult: {
            status: "CreatedWithOpenConnectors",
            plannedPoints: [{ x: 40, y: 27 }, { x: 58, y: 27 }],
            segmentCount: 1,
            chosenSize: { requested: "12x10", applied: "12x10" },
            createdElementIds: [],
            createdFittingIds: [],
            openConnectorCount: 2
          },
          visualVerification: { status: "CaptureReadyForAIReview", capturePath: "C:/captures/redline.jpg" }
        }
      }
    ]
  }));

  assert.equal(response.ok, false);
  assert.equal(response.handled, true);
  assert.equal(response.next_action, undefined);
  assert.equal(response.task?.verification?.status, "applied_visual_incomplete");
  assert.deepEqual(response.task?.verification?.created_element_ids, []);
  assert.equal(response.task?.verification?.spatial_assertion?.status, "passed");
  assert.equal(response.task?.verification?.visual_gate?.status, "fail");
  assert.equal(response.task?.verification?.visual_gate?.assertions.some(a => a.name === "model_write_evidence_present" && a.status === "fail"), true);
  assert.match(response.assistant_message, /model element\/fitting IDs/i);
});

test("MEP route redline resolver refuses completion when created workflow route is spatially off target", async () => {
  const response = await resolveMepRouteRedline(request({
    analysis: targetPathAnalysis(),
    tool_results: [
      sheetDetailToolResult(),
      {
        action_id: "pick",
        method: "POST",
        path: "/revit/pick-at-pixel",
        status: "done",
        result_json: { pickPointXyz: [-2.718, -9.101, -467.883], best: null, hits: [] }
      },
      {
        action_id: "workflow",
        method: "POST",
        path: "/revit/mep-route-workflow",
        status: "done",
        result_json: {
          status: "AppliedVisualVerificationReady",
          applyResult: {
            status: "CreatedWithOpenConnectors",
            plannedPoints: [{ x: -89.118, y: -17.933 }, { x: 83.682, y: -17.933 }],
            segmentCount: 1,
            chosenSize: { requested: "12x10", applied: "12x10" },
            createdElementIds: [1542929],
            createdFittingIds: [],
            openConnectorCount: 2
          },
          visualVerification: { status: "CaptureReadyForAIReview", capturePath: "C:/captures/redline.jpg" }
        }
      }
    ]
  }));

  assert.equal(response.ok, false);
  assert.equal(response.task?.verification?.status, "applied_visual_incomplete");
  assert.equal(response.task?.verification?.spatial_assertion?.status, "failed");
  assert.equal(response.task?.verification?.visual_gate?.status, "fail");
  assert.match(response.assistant_message, /Spatial assertion failed/i);
});
