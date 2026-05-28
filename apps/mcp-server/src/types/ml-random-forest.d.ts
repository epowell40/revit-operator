declare module "ml-random-forest" {
  export class RandomForestClassifier {
    constructor(options?: any);
    static load(modelState: any): RandomForestClassifier;
    train(trainingSet: any, labels: any): void;
    predict(data: any): any;
  }
}
