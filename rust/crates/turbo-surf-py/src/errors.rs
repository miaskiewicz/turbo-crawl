//! The binding's error type. Fatal faults (bad schema JSON, a render-tier
//! failure) are raised as `TurboSurfError`; everything else returns normally.

use pyo3::create_exception;
use pyo3::exceptions::PyException;

create_exception!(
    turbo_surf,
    TurboSurfError,
    PyException,
    "A fatal turbo-surf engine fault (invalid input or a render-tier failure)."
);
