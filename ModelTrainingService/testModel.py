#!/usr/bin/env python3

import sys
import joblib

MODEL_PATH = "./out/intent-model_current/model.joblib"


def main():
    # ensure input text is provided
    if len(sys.argv) < 2:
        print('usage: python test_model.py "your text here"')
        raise SystemExit(1)

    # grab input text and load model
    text = " ".join(sys.argv[1:]).strip()
    model = joblib.load(MODEL_PATH)

    # make prediction and print results
    pred = model.predict([text])[0]
    print(pred)

    # if model supports predict_proba, print confidence scores for each class & print in descending order
    if hasattr(model, "predict_proba"):
        probs = model.predict_proba([text])[0]
        classes = model.named_steps["clf"].classes_
        for label, prob in sorted(
            zip(classes, probs), key=lambda x: x[1], reverse=True
        ):
            print(f"{label}: {prob:.4f}")


if __name__ == "__main__":
    main()
