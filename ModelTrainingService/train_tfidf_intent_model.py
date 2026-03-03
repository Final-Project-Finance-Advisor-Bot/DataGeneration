# train_intent_model.py
# Trains a TF-IDF + LogisticRegression intent classifier, evaluates on a held-out
# validation split (synthetic sanity check), and writes:
#   - model.joblib
#   - metadata.json
#
# Usage examples:
#   python train_intent_model.py --dataset ./dataset.jsonl
import argparse
import json
import os
import platform
from datetime import datetime, timezone

import joblib
import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    classification_report,
    confusion_matrix,
    f1_score,
)
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
import sklearn


def load_jsonl_from_data_dir(data_dir: str):
    """
    Loads text and label data from JSONL files in the specified directory.
    """
    texts = []
    labels = []

    # find all JSONL files in the directory
    files = sorted(f for f in os.listdir(data_dir) if f.endswith(".jsonl"))

    if not files:
        raise RuntimeError(f"No JSONL files found in: {data_dir}")

    print("\nLoading datasets:")

    # iterate through files and load text/label pairs
    for file in files:
        path = os.path.join(data_dir, file)
        print(f"- {file}")

        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue

                obj = json.loads(line)
                texts.append(obj["text"])
                labels.append(obj["label"])

    print(f"\nLoaded {len(files)} dataset files\n")

    return texts, labels


def print_dataset_health(labels):
    """
    Prints basic dataset health metrics: total samples, unique labels, and counts per label.
    Args:
        labels: List of label strings corresponding to the dataset samples.
    """
    labels = list(labels)
    uniq = sorted(set(labels))
    print("\n=== Dataset health ===")
    print(f"Total samples: {len(labels)}")
    print(f"Unique labels: {len(uniq)}")
    counts = {k: 0 for k in uniq}
    for y in labels:
        counts[y] += 1
    for k in uniq:
        print(f"- {k}: {counts[k]}")
    print("======================\n")


def make_json_safe(d):
    """Converts a dictionary to a JSON-safe format by converting non-serializable values to strings.
    Args:
        d: Dictionary to convert.
        Returns: A new dictionary where all values are JSON-serializable.
    """
    safe = {}
    # get all key-value pairs in the input dictionary
    for k, v in d.items():
        try:
            # attempt to serialize the value to JSON
            json.dumps(v)
            safe[k] = v
        except TypeError:
            # if serialization fails, convert the value to a string
            safe[k] = str(v)
    return safe


def main():
    """
    Main function to train the intent classification model. Parses command-line arguments, loads the dataset,
    """
    parser = argparse.ArgumentParser(
        description="Train an intent routing model (TF-IDF + LogisticRegression)."
    )
    parser.add_argument(
        "--dataset",
        required=True,
        help="Path to dataset directory containing JSONL files (e.g. ./data)",
    )
    parser.add_argument(
        "--test-size",
        type=float,
        default=0.2,
        help="Validation split ratio (default: 0.2)",
    )
    parser.add_argument(
        "--seed", type=int, default=42, help="Random seed for reproducibility"
    )
    parser.add_argument(
        "--max-features",
        type=int,
        default=5000,
        help="TF-IDF max_features (default: 5000)",
    )
    parser.add_argument(
        "--ngrams", default="1,2", help='ngram_range as "min,max" (default: 1,2)'
    )
    parser.add_argument(
        "--stop-words",
        default="none",
        choices=["none", "english"],
        help="Stopwords (default: none)",
    )
    parser.add_argument(
        "--C",
        type=float,
        default=2.0,
        help="LogReg regularization strength (default: 2.0)",
    )
    parser.add_argument(
        "--solver",
        default="lbfgs",
        choices=["lbfgs", "liblinear", "saga"],
        help="LogReg solver",
    )
    parser.add_argument(
        "--max-iter", type=int, default=2000, help="LogReg max_iter (default: 2000)"
    )
    args = parser.parse_args()

    out = "./out"

    dataset_path = args.dataset
    if not os.path.exists(dataset_path):
        raise FileNotFoundError(f"Dataset not found: {dataset_path}")

    # set up artifact directory
    model_name = f"intent-model_current"
    artifact_dir = os.path.join(out, model_name)
    os.makedirs(artifact_dir, exist_ok=True)

    # declare ngram range and stop words based on args
    nmin, nmax = (int(x.strip()) for x in args.ngrams.split(","))
    stop_words = None if args.stop_words == "none" else "english"

    # load dataset
    texts, labels = load_jsonl_from_data_dir(dataset_path)

    if len(texts) == 0:
        raise RuntimeError("Dataset is empty. Training aborted.")

    # print dataset health metrics
    print_dataset_health(labels)

    # test-train split with stratification to maintain label distribution
    X_train, X_val, y_train, y_val = train_test_split(
        texts,
        labels,
        test_size=args.test_size,
        random_state=args.seed,
        stratify=labels,
    )

    # build pipeline: TF-IDF vectorizer + Logistic Regression classifier
    pipeline = Pipeline(
        steps=[
            (
                "tfidf",
                TfidfVectorizer(
                    ngram_range=(nmin, nmax),
                    max_features=args.max_features,
                    stop_words=stop_words,
                ),
            ),
            (
                "clf",
                LogisticRegression(
                    max_iter=args.max_iter,
                    C=args.C,
                    solver=args.solver,
                    class_weight=None,
                    random_state=args.seed,
                ),
            ),
        ]
    )

    # train model
    pipeline.fit(X_train, y_train)

    # evaluate on validation set
    y_pred = pipeline.predict(X_val)

    acc = accuracy_score(y_val, y_pred)
    macro_f1 = f1_score(y_val, y_pred, average="macro")

    print("\n=== Validation metrics ===")
    print(f"Accuracy:  {acc:.4f}")
    print(f"Macro F1:  {macro_f1:.4f}")
    print("\nPer-class report:\n")
    print(classification_report(y_val, y_pred, digits=4))

    # confusion matrixs
    label_order = list(pipeline.named_steps["clf"].classes_)
    cm = confusion_matrix(y_val, y_pred, labels=label_order)

    print("Confusion matrix (rows=true, cols=pred):")
    print("Labels:", label_order)
    print(cm)
    print("=========================\n")

    # save model and metadata
    model_path = os.path.join(artifact_dir, "model.joblib")
    joblib.dump(pipeline, model_path)

    metadata = {
        "trained_at_utc": datetime.now(timezone.utc).isoformat(),
        "dataset_path": os.path.abspath(dataset_path),
        "model_type": "TF-IDF + LogisticRegression",
        "labels": label_order,
        "metrics": {
            "val_accuracy": float(acc),
            "val_macro_f1": float(macro_f1),
        },
        "tfidf_params": make_json_safe(pipeline.named_steps["tfidf"].get_params()),
        "clf_params": make_json_safe(pipeline.named_steps["clf"].get_params()),
        "versions": {
            "python": platform.python_version(),
            "sklearn": sklearn.__version__,
            "joblib": joblib.__version__,
            "numpy": np.__version__,
        },
    }

    # analyze misclassifications and save to a JSONL file for error analysis
    probas = pipeline.predict_proba(X_val)
    misclassified = []
    for i, (text, true_label, pred_label) in enumerate(zip(X_val, y_val, y_pred)):
        if true_label != pred_label:
            probs = probas[i]
            top_idx = int(np.argmax(probs))
            top_prob = float(probs[top_idx])

            # margin = difference between top and second probability
            second_prob = float(np.partition(probs, -2)[-2]) if len(probs) > 1 else 0.0
            margin = top_prob - second_prob

            # append misclassified example with relevant info for error analysis
            misclassified.append(
                {
                    "text": text,
                    "true_label": true_label,
                    "predicted_label": pred_label,
                    "top_probability": top_prob,
                    "margin": margin,
                }
            )

    metadata_path = os.path.join(artifact_dir, "metadata.json")
    with open(metadata_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2)

    # overwrite misclassifications.jsonl with the new misclassified examples
    mis_path = os.path.join(artifact_dir, "misclassifications.jsonl")
    with open(mis_path, "w", encoding="utf-8") as f:
        for row in misclassified:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    print(f"Saved misclassifications: {mis_path}")
    print(f"Total misclassified: {len(misclassified)}")

    print(f"Saved model:    {model_path}")
    print(f"Saved metadata: {metadata_path}")
    print(f"Artifact dir:   {artifact_dir}")

    # test confidence signal on an example input (not from val set, just a sanity check)
    example = "Take me to my portfolio manager"
    proba = pipeline.predict_proba([example])[0]
    top_idx = int(np.argmax(proba))
    top_label = label_order[top_idx]
    top_prob = float(proba[top_idx])
    second_prob = float(np.partition(proba, -2)[-2]) if len(proba) > 1 else 0.0
    margin = top_prob - second_prob

    print("\n=== Example confidence signal ===")
    print(f'Text: "{example}"')
    print(f"Top label: {top_label}")
    print(f"Top prob:  {top_prob:.4f}")
    print(f"Margin:    {margin:.4f}")
    print("================================\n")


if __name__ == "__main__":
    main()
