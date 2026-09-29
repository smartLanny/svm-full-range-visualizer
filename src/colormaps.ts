
import * as THREE from 'three';
import { ColormapType } from './types';

export const getGlslColorFunction = (type: ColormapType) => {
    switch (type) {
        case ColormapType.JET:
            return `
            vec3 getHeatmapColor(float svm) {
                float t = clamp(svm / 4.0, 0.0, 1.0);
                float r = clamp(1.5 - abs(4.0 * t - 3.0), 0.0, 1.0);
                float g = clamp(1.5 - abs(4.0 * t - 2.0), 0.0, 1.0);
                float b = clamp(1.5 - abs(4.0 * t - 1.0), 0.0, 1.0);
                return vec3(r, g, b);
            }
            `;
        case ColormapType.RD_YL_BU:
            return `
            vec3 getHeatmapColor(float svm) {
                vec3 cDeepBlue = vec3(0.192, 0.212, 0.584);
                vec3 cLightBlue = vec3(0.455, 0.678, 0.820);
                vec3 cPaleYellow = vec3(1.000, 1.000, 0.749);
                vec3 cOrange = vec3(0.992, 0.682, 0.380);
                vec3 cDeepRed = vec3(0.847, 0.050, 0.149);
        
                if (svm < 0.4) {
                    return mix(cDeepBlue, cLightBlue, svm / 0.4);
                } else if (svm < 1.0) {
                    return mix(cLightBlue, cPaleYellow, (svm - 0.4) / 0.6);
                } else if (svm < 2.5) {
                    return mix(cPaleYellow, cOrange, (svm - 1.0) / 1.5);
                } else {
                    return mix(cOrange, cDeepRed, clamp((svm - 2.5) / 1.5, 0.0, 1.0));
                }
            }
            `;
        case ColormapType.RD_YL_BU_R:
            return `
            vec3 getHeatmapColor(float svm) {
                vec3 cDeepBlue = vec3(0.192, 0.212, 0.584);
                vec3 cLightBlue = vec3(0.455, 0.678, 0.820);
                vec3 cPaleYellow = vec3(1.000, 1.000, 0.749);
                vec3 cOrange = vec3(0.992, 0.682, 0.380);
                vec3 cDeepRed = vec3(0.847, 0.050, 0.149);
                
                // Reverse logic: High SVM (4.0) -> Blue, Low SVM (0.0) -> Red
                // Or rather, we just invert t.
                // Original RD_YL_BU maps 0.0->Blue, 4.0->Red.
                // RD_YL_BU_R should map 0.0->Red, 4.0->Blue.
                // So we can use the same logic but map input svm to an inverted scale.
                
                // Original logic is based on absolute SVM thresholds (0.4, 1.0, 2.5).
                // To reverse it properly, we should map the colors to t (0-1) and then invert t.
                // But the original logic has non-linear stops (0.1, 0.25, 0.625).
                // Let's implement it manually for best control.
                
                // Stops: 0.0 (Red), 0.375 (Orange), 0.75 (Yellow), 0.9 (LBlue), 1.0 (DBlue)
                // Corresponding SVM (approx): 0.0, 1.5, 3.0, 3.6, 4.0
                
                // Let's just use linear interpolation between the 5 colors distributed evenly or use the same non-linear distribution inverted.
                // Inverted thresholds:
                // Old: 0.0(Blue) -> 0.4(LBlue) -> 1.0(Yellow) -> 2.5(Orange) -> 4.0(Red)
                // New: 0.0(Red) -> 1.5(Orange) -> 3.0(Yellow) -> 3.6(LBlue) -> 4.0(Blue)
                
                if (svm < 1.5) {
                    return mix(cDeepRed, cOrange, svm / 1.5);
                } else if (svm < 3.0) {
                    return mix(cOrange, cPaleYellow, (svm - 1.5) / 1.5);
                } else if (svm < 3.6) {
                    return mix(cPaleYellow, cLightBlue, (svm - 3.0) / 0.6);
                } else {
                    return mix(cLightBlue, cDeepBlue, clamp((svm - 3.6) / 0.4, 0.0, 1.0));
                }
            }
            `;
        case ColormapType.VIRIDIS:
            return `
            vec3 getHeatmapColor(float svm) {
                // Inverted: Low SVM (Light) -> High SVM (Dark)
                float t = 1.0 - clamp(svm / 4.0, 0.0, 1.0);
                vec3 c0 = vec3(0.267, 0.004, 0.329); // Purple
                vec3 c1 = vec3(0.229, 0.322, 0.545); // Blue
                vec3 c2 = vec3(0.128, 0.567, 0.551); // Teal
                vec3 c3 = vec3(0.369, 0.787, 0.383); // Green
                vec3 c4 = vec3(0.993, 0.906, 0.144); // Yellow
                
                if (t < 0.25) return mix(c0, c1, t / 0.25);
                if (t < 0.50) return mix(c1, c2, (t - 0.25) / 0.25);
                if (t < 0.75) return mix(c2, c3, (t - 0.50) / 0.25);
                return mix(c3, c4, (t - 0.75) / 0.25);
            }
            `;
        case ColormapType.PLASMA:
            return `
            vec3 getHeatmapColor(float svm) {
                // Inverted: Low SVM (Light) -> High SVM (Dark)
                float t = 1.0 - clamp(svm / 4.0, 0.0, 1.0);
                vec3 c0 = vec3(0.051, 0.031, 0.529); // Blue
                vec3 c1 = vec3(0.494, 0.012, 0.659); // Purple
                vec3 c2 = vec3(0.796, 0.278, 0.471); // Pink
                vec3 c3 = vec3(0.972, 0.580, 0.255); // Orange
                vec3 c4 = vec3(0.941, 0.976, 0.129); // Yellow
                
                if (t < 0.25) return mix(c0, c1, t / 0.25);
                if (t < 0.50) return mix(c1, c2, (t - 0.25) / 0.25);
                if (t < 0.75) return mix(c2, c3, (t - 0.50) / 0.25);
                return mix(c3, c4, (t - 0.75) / 0.25);
            }
            `;
        case ColormapType.INFERNO:
            return `
            vec3 getHeatmapColor(float svm) {
                // Inverted: Low SVM (Light) -> High SVM (Dark)
                float t = 1.0 - clamp(svm / 4.0, 0.0, 1.0);
                vec3 c0 = vec3(0.000, 0.000, 0.016); // Black
                vec3 c1 = vec3(0.259, 0.039, 0.408); // Purple
                vec3 c2 = vec3(0.576, 0.153, 0.404); // Red/Purple
                vec3 c3 = vec3(0.867, 0.373, 0.176); // Orange
                vec3 c4 = vec3(0.988, 0.992, 0.647); // Yellow
                
                if (t < 0.25) return mix(c0, c1, t / 0.25);
                if (t < 0.50) return mix(c1, c2, (t - 0.25) / 0.25);
                if (t < 0.75) return mix(c2, c3, (t - 0.50) / 0.25);
                return mix(c3, c4, (t - 0.75) / 0.25);
            }
            `;
        case ColormapType.MAGMA:
            return `
            vec3 getHeatmapColor(float svm) {
                // Inverted: Low SVM (Light) -> High SVM (Dark)
                float t = 1.0 - clamp(svm / 4.0, 0.0, 1.0);
                vec3 c0 = vec3(0.001, 0.000, 0.005); // Black
                vec3 c1 = vec3(0.145, 0.063, 0.333); // Purple
                vec3 c2 = vec3(0.459, 0.102, 0.427); // Red
                vec3 c3 = vec3(0.882, 0.329, 0.310); // Orange
                vec3 c4 = vec3(0.988, 0.992, 0.749); // Yellow
                
                if (t < 0.25) return mix(c0, c1, t / 0.25);
                if (t < 0.50) return mix(c1, c2, (t - 0.25) / 0.25);
                if (t < 0.75) return mix(c2, c3, (t - 0.50) / 0.25);
                return mix(c3, c4, (t - 0.75) / 0.25);
            }
            `;
        case ColormapType.TRAFFIC_LIGHT:
            return `
            vec3 getHeatmapColor(float svm) {
                // 0.0 (Green) -> 1.0 (Yellow) -> 2.5+ (Red)
                vec3 cGreen = vec3(0.0, 0.8, 0.2);
                vec3 cYellow = vec3(1.0, 0.9, 0.1);
                vec3 cRed = vec3(0.9, 0.1, 0.1);
                
                if (svm < 1.0) {
                    return mix(cGreen, cYellow, svm);
                } else {
                    return mix(cYellow, cRed, clamp((svm - 1.0) / 1.5, 0.0, 1.0));
                }
            }
            `;
        case ColormapType.COOL_WARM:
             return `
             vec3 getHeatmapColor(float svm) {
                 // 0.0 (Cool Blue) -> 1.0 (White) -> 2.5+ (Deep Red)
                 vec3 cBlue = vec3(0.1, 0.4, 0.8);
                 vec3 cWhite = vec3(0.95, 0.95, 0.95);
                 vec3 cRed = vec3(0.8, 0.0, 0.2);
                 
                 if (svm < 1.0) {
                     return mix(cBlue, cWhite, svm);
                 } else {
                     return mix(cWhite, cRed, clamp((svm - 1.0) / 1.5, 0.0, 1.0));
                 }
             }
             `;
        case ColormapType.RD_YL_BU_ENHANCED:
            return `
            vec3 getHeatmapColor(float svm) {
                // Enhanced RdYlBu with Perceptually Uniform Steps:
                // 0.0 (Deep Blue) -> 0.5 (Sky Blue) -> 1.0 (Pale Yellow)
                // -> 2.0 (Orange) -> 3.0 (Red) -> 4.0 (Dark Red)
                
                vec3 cDeepBlue = vec3(0.106, 0.235, 0.584);
                vec3 cSkyBlue = vec3(0.455, 0.678, 0.820);
                vec3 cPaleYellow = vec3(1.000, 1.000, 0.800);
                vec3 cOrange = vec3(1.000, 0.600, 0.100);
                vec3 cRed = vec3(0.850, 0.100, 0.100);
                vec3 cDarkRed = vec3(0.250, 0.000, 0.050);
                
                if (svm < 0.5) {
                    return mix(cDeepBlue, cSkyBlue, svm / 0.5);
                } else if (svm < 1.0) {
                    return mix(cSkyBlue, cPaleYellow, (svm - 0.5) / 0.5);
                } else if (svm < 2.0) {
                    return mix(cPaleYellow, cOrange, (svm - 1.0) / 1.0);
                } else if (svm < 3.0) {
                    return mix(cOrange, cRed, (svm - 2.0) / 1.0);
                } else {
                    return mix(cRed, cDarkRed, clamp((svm - 3.0) / 1.0, 0.0, 1.0));
                }
            }
            `;
         case ColormapType.TURBO:
        default:
            return `
            vec3 getHeatmapColor(float svm) {
                float t = clamp(svm / 4.0, 0.0, 1.0);
                vec3 c0 = vec3(0.188, 0.070, 0.231);
                vec3 c1 = vec3(0.274, 0.525, 0.984);
                vec3 c2 = vec3(0.094, 0.843, 0.796);
                vec3 c3 = vec3(0.643, 0.988, 0.235);
                vec3 c4 = vec3(0.949, 0.619, 0.180);
                vec3 c5 = vec3(0.478, 0.015, 0.011);
        
                if (t < 0.2) return mix(c0, c1, t / 0.2);
                if (t < 0.4) return mix(c1, c2, (t - 0.2) / 0.2);
                if (t < 0.6) return mix(c2, c3, (t - 0.4) / 0.2);
                if (t < 0.8) return mix(c3, c4, (t - 0.6) / 0.2);
                return mix(c4, c5, (t - 0.8) / 0.2);
            }
            `;
    }
};

export const getJsColor = (svm: number, type: ColormapType, target: THREE.Color) => {
    const t = Math.min(Math.max(svm / 4.0, 0.0), 1.0);

    if (type === ColormapType.JET) {
        const r = Math.max(0, Math.min(1, 1.5 - Math.abs(4.0 * t - 3.0)));
        const g = Math.max(0, Math.min(1, 1.5 - Math.abs(4.0 * t - 2.0)));
        const b = Math.max(0, Math.min(1, 1.5 - Math.abs(4.0 * t - 1.0)));
        target.setRGB(r, g, b);
        return;
    }

    if (type === ColormapType.RD_YL_BU) {
         const cDeepBlue = new THREE.Color(0.192, 0.212, 0.584);
         const cLightBlue = new THREE.Color(0.455, 0.678, 0.820);
         const cPaleYellow = new THREE.Color(1.000, 1.000, 0.749);
         const cOrange = new THREE.Color(0.992, 0.682, 0.380);
         const cDeepRed = new THREE.Color(0.847, 0.050, 0.149);

         if (svm < 0.4) {
             target.copy(cDeepBlue).lerp(cLightBlue, svm / 0.4);
         } else if (svm < 1.0) {
             target.copy(cLightBlue).lerp(cPaleYellow, (svm - 0.4) / 0.6);
         } else if (svm < 2.5) {
             target.copy(cPaleYellow).lerp(cOrange, (svm - 1.0) / 1.5);
         } else {
             target.copy(cOrange).lerp(cDeepRed, Math.min(1.0, (svm - 2.5) / 1.5));
         }
         return;
    }

    if (type === ColormapType.RD_YL_BU_R) {
        const cDeepBlue = new THREE.Color(0.192, 0.212, 0.584);
        const cLightBlue = new THREE.Color(0.455, 0.678, 0.820);
        const cPaleYellow = new THREE.Color(1.000, 1.000, 0.749);
        const cOrange = new THREE.Color(0.992, 0.682, 0.380);
        const cDeepRed = new THREE.Color(0.847, 0.050, 0.149);

        if (svm < 1.5) {
            target.copy(cDeepRed).lerp(cOrange, svm / 1.5);
        } else if (svm < 3.0) {
            target.copy(cOrange).lerp(cPaleYellow, (svm - 1.5) / 1.5);
        } else if (svm < 3.6) {
            target.copy(cPaleYellow).lerp(cLightBlue, (svm - 3.0) / 0.6);
        } else {
            target.copy(cLightBlue).lerp(cDeepBlue, Math.min(1.0, (svm - 3.6) / 0.4));
        }
        return;
    }

    if (type === ColormapType.VIRIDIS) {
        const t = 1.0 - Math.min(Math.max(svm / 4.0, 0.0), 1.0); // Invert t
        const c0 = new THREE.Color(0.267, 0.004, 0.329);
        const c1 = new THREE.Color(0.229, 0.322, 0.545);
        const c2 = new THREE.Color(0.128, 0.567, 0.551);
        const c3 = new THREE.Color(0.369, 0.787, 0.383);
        const c4 = new THREE.Color(0.993, 0.906, 0.144);

        if (t < 0.25) target.copy(c0).lerp(c1, t / 0.25);
        else if (t < 0.50) target.copy(c1).lerp(c2, (t - 0.25) / 0.25);
        else if (t < 0.75) target.copy(c2).lerp(c3, (t - 0.50) / 0.25);
        else target.copy(c3).lerp(c4, (t - 0.75) / 0.25);
        return;
    }

    if (type === ColormapType.PLASMA) {
        const t = 1.0 - Math.min(Math.max(svm / 4.0, 0.0), 1.0); // Invert t
        const c0 = new THREE.Color(0.051, 0.031, 0.529);
        const c1 = new THREE.Color(0.494, 0.012, 0.659);
        const c2 = new THREE.Color(0.796, 0.278, 0.471);
        const c3 = new THREE.Color(0.972, 0.580, 0.255);
        const c4 = new THREE.Color(0.941, 0.976, 0.129);

        if (t < 0.25) target.copy(c0).lerp(c1, t / 0.25);
        else if (t < 0.50) target.copy(c1).lerp(c2, (t - 0.25) / 0.25);
        else if (t < 0.75) target.copy(c2).lerp(c3, (t - 0.50) / 0.25);
        else target.copy(c3).lerp(c4, (t - 0.75) / 0.25);
        return;
    }

    if (type === ColormapType.INFERNO) {
        const t = 1.0 - Math.min(Math.max(svm / 4.0, 0.0), 1.0); // Invert t
        const c0 = new THREE.Color(0.000, 0.000, 0.016);
        const c1 = new THREE.Color(0.259, 0.039, 0.408);
        const c2 = new THREE.Color(0.576, 0.153, 0.404);
        const c3 = new THREE.Color(0.867, 0.373, 0.176);
        const c4 = new THREE.Color(0.988, 0.992, 0.647);

        if (t < 0.25) target.copy(c0).lerp(c1, t / 0.25);
        else if (t < 0.50) target.copy(c1).lerp(c2, (t - 0.25) / 0.25);
        else if (t < 0.75) target.copy(c2).lerp(c3, (t - 0.50) / 0.25);
        else target.copy(c3).lerp(c4, (t - 0.75) / 0.25);
        return;
    }

    if (type === ColormapType.MAGMA) {
        const t = 1.0 - Math.min(Math.max(svm / 4.0, 0.0), 1.0); // Invert t
        const c0 = new THREE.Color(0.001, 0.000, 0.005);
        const c1 = new THREE.Color(0.145, 0.063, 0.333);
        const c2 = new THREE.Color(0.459, 0.102, 0.427);
        const c3 = new THREE.Color(0.882, 0.329, 0.310);
        const c4 = new THREE.Color(0.988, 0.992, 0.749);

        if (t < 0.25) target.copy(c0).lerp(c1, t / 0.25);
        else if (t < 0.50) target.copy(c1).lerp(c2, (t - 0.25) / 0.25);
        else if (t < 0.75) target.copy(c2).lerp(c3, (t - 0.50) / 0.25);
        else target.copy(c3).lerp(c4, (t - 0.75) / 0.25);
        return;
    }
    
    if (type === ColormapType.TRAFFIC_LIGHT) {
        const cGreen = new THREE.Color(0.0, 0.8, 0.2);
        const cYellow = new THREE.Color(1.0, 0.9, 0.1);
        const cRed = new THREE.Color(0.9, 0.1, 0.1);
        
        if (svm < 1.0) {
            target.copy(cGreen).lerp(cYellow, svm);
        } else {
            target.copy(cYellow).lerp(cRed, Math.min(1.0, (svm - 1.0) / 1.5));
        }
        return;
    }

    if (type === ColormapType.COOL_WARM) {
        const cBlue = new THREE.Color(0.1, 0.4, 0.8);
        const cWhite = new THREE.Color(0.95, 0.95, 0.95);
        const cRed = new THREE.Color(0.8, 0.0, 0.2);
        
        if (svm < 1.0) {
            target.copy(cBlue).lerp(cWhite, svm);
        } else {
            target.copy(cWhite).lerp(cRed, Math.min(1.0, (svm - 1.0) / 1.5));
        }
        return;
    }

    if (type === ColormapType.RD_YL_BU_ENHANCED) {
        const cDeepBlue = new THREE.Color(0.106, 0.235, 0.584);
        const cSkyBlue = new THREE.Color(0.455, 0.678, 0.820);
        const cPaleYellow = new THREE.Color(1.000, 1.000, 0.800);
        const cOrange = new THREE.Color(1.000, 0.600, 0.100);
        const cRed = new THREE.Color(0.850, 0.100, 0.100);
        const cDarkRed = new THREE.Color(0.250, 0.000, 0.050);

        if (svm < 0.5) {
            target.copy(cDeepBlue).lerp(cSkyBlue, svm / 0.5);
        } else if (svm < 1.0) {
            target.copy(cSkyBlue).lerp(cPaleYellow, (svm - 0.5) / 0.5);
        } else if (svm < 2.0) {
            target.copy(cPaleYellow).lerp(cOrange, (svm - 1.0) / 1.0);
        } else if (svm < 3.0) {
            target.copy(cOrange).lerp(cRed, (svm - 2.0) / 1.0);
        } else {
            target.copy(cRed).lerp(cDarkRed, Math.min(1.0, (svm - 3.0) / 1.0));
        }
        return;
    }

    // Default: Turbo
    const c0 = new THREE.Color(0.188, 0.070, 0.231);
    const c1 = new THREE.Color(0.274, 0.525, 0.984);
    const c2 = new THREE.Color(0.094, 0.843, 0.796);
    const c3 = new THREE.Color(0.643, 0.988, 0.235);
    const c4 = new THREE.Color(0.949, 0.619, 0.180);
    const c5 = new THREE.Color(0.478, 0.015, 0.011);

    if (t < 0.2) target.copy(c0).lerp(c1, t / 0.2);
    else if (t < 0.4) target.copy(c1).lerp(c2, (t - 0.2) / 0.2);
    else if (t < 0.6) target.copy(c2).lerp(c3, (t - 0.4) / 0.2);
    else if (t < 0.8) target.copy(c3).lerp(c4, (t - 0.6) / 0.2);
    else target.copy(c4).lerp(c5, (t - 0.8) / 0.2);
};
